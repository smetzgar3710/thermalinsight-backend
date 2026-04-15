const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: [
    'https://thermal-insight.netlify.app',
    'http://localhost',
    'http://localhost:3000',
    'null',
  ],
  methods: ['GET'],
}));
app.use(express.json());

// ── Database Configuration ────────────────────────────────────────────────────
const dbConfig = {
  user: 'ThermalInsightReader',
  password: 'TIReader2024!',
  server: 'THERMAL-ONE',            // Replace with external IP/hostname from Meriplex
  database: 'ThermalMIETrakLive',
  port: 1433,
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  connectionTimeout: 30000,
  requestTimeout: 30000,
};

let pool = null;
async function getPool() {
  if (!pool) pool = await sql.connect(dbConfig);
  return pool;
}

// ── Division Grouping ─────────────────────────────────────────────────────────
const CLASS_TO_DIVISION = {
  'TS':'TS','TSFG':'TS',
  'BH':'BH','BHFG':'BH',
  'CH':'CH','CHFG':'CH',
  'KB':'KB',
  'RE':'RE',
  'NB':'NB','NBFG':'NB',
  'FB':'FB',
  'MOS':'Other','UN':'Other',
};

const CORE_DIVISIONS = ['TS','BH','CH','KB','RE','NB','FB'];

const DIVISION_LABELS = {
  'TS':'Temperature Sensors','BH':'Band Heaters','CH':'Cartridge Heaters',
  'KB':'Knuckle Band','RE':'Resale','NB':'Nozzle Band','FB':'SOTAMB','Other':'Other',
};

function getDivision(classCode) {
  if (!classCode) return 'Other';
  if (classCode.startsWith('C-') || classCode.startsWith('X-')) return null;
  return CLASS_TO_DIVISION[classCode] || 'Other';
}

function addDivision(rows) {
  return rows.map(r => ({
    ...r,
    DivisionName: getDivision(r.ClassCode) || 'Other',
    DivisionLabel: DIVISION_LABELS[getDivision(r.ClassCode)] || r.ClassName,
  }));
}

// ── Queries ───────────────────────────────────────────────────────────────────

const SUMMARY_QUERY = `
  SELECT
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    COUNT(DISTINCT i.ItemPK)                                             AS TotalParts,
    SUM(ii.QuantityOnHand * NULLIF(ii.AverageCost,0))                   AS TotalInventoryValue,
    SUM(CASE WHEN ii.QuantityOnHand <= 0
             AND i.ReorderPoint > 0 THEN 1 ELSE 0 END)                  AS StockoutCount,
    SUM(CASE WHEN i.MaximumQuantityOnHand > 0
             AND ii.QuantityOnHand > i.MaximumQuantityOnHand
             THEN 1 ELSE 0 END)                                          AS OverstockCount,
    SUM(CASE WHEN ii.QuantityOnHand > 0
             AND (ii.LastTransactionDate IS NULL
                  OR ii.LastTransactionDate < DATEADD(day,-90,GETDATE()))
             THEN 1 ELSE 0 END)                                          AS SlowMoverCount
  FROM Item i
  JOIN ItemInventory ii ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic     ON ic.ItemClassPK = i.ItemClassFK
  WHERE i.Inventoriable = 1 AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%' AND ic.Code NOT LIKE 'X-%'
  GROUP BY ic.Code, ic.Name
  ORDER BY ic.Code
`;

// Stockout query — uses TRUE QOH only, ignores QuantityDemand distortion
const STOCKOUT_QUERY = `
  SELECT TOP 300
    i.PartNumber,
    i.Description,
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    ii.QuantityOnHand,
    ii.QuantityDemand,
    -- True available = QOH only (demand may be future/distorted)
    ii.QuantityOnHand                                                    AS TrueAvailable,
    i.ReorderPoint,
    ii.QuantityOrdered,
    ii.QuantityOnDock,
    ii.LastTransactionDate,
    ii.AverageCost,
    ii.LastSellDate,
    ii.LastSellPrice,
    i.LeadTime
  FROM Item i
  JOIN ItemInventory ii ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic     ON ic.ItemClassPK = i.ItemClassFK
  WHERE ii.QuantityOnHand <= 0
    AND i.ReorderPoint > 0
    AND i.Inventoriable = 1 AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%' AND ic.Code NOT LIKE 'X-%'
  ORDER BY i.ReorderPoint DESC
`;

// Overstock query
const OVERSTOCK_QUERY = `
  SELECT TOP 300
    i.PartNumber,
    i.Description,
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    ii.QuantityOnHand,
    ii.QuantityDemand,
    i.MaximumQuantityOnHand,
    i.ReorderPoint,
    ii.AverageCost,
    (ii.QuantityOnHand - i.MaximumQuantityOnHand)                       AS ExcessQty,
    ((ii.QuantityOnHand - i.MaximumQuantityOnHand) * ii.AverageCost)    AS ExcessValue,
    ii.LastTransactionDate,
    i.LeadTime
  FROM Item i
  JOIN ItemInventory ii ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic     ON ic.ItemClassPK = i.ItemClassFK
  WHERE i.MaximumQuantityOnHand > 0
    AND ii.QuantityOnHand > i.MaximumQuantityOnHand
    AND i.Inventoriable = 1 AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%' AND ic.Code NOT LIKE 'X-%'
  ORDER BY ExcessValue DESC
`;

// Slow movers query
const SLOW_MOVER_QUERY = `
  SELECT TOP 300
    i.PartNumber,
    i.Description,
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    ii.QuantityOnHand,
    ii.AverageCost,
    ii.StandardCost,
    (ii.QuantityOnHand * NULLIF(ii.AverageCost,0))                      AS InventoryValue,
    ii.LastTransactionDate,
    DATEDIFF(day, ii.LastTransactionDate, GETDATE())                     AS DaysSinceLastTransaction,
    i.EstimatedAnnualUsage,
    ii.LastSellDate,
    i.LeadTime
  FROM Item i
  JOIN ItemInventory ii ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic     ON ic.ItemClassPK = i.ItemClassFK
  WHERE ii.QuantityOnHand > 0
    AND (ii.LastTransactionDate IS NULL
         OR ii.LastTransactionDate < DATEADD(day,-90,GETDATE()))
    AND i.Inventoriable = 1 AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%' AND ic.Code NOT LIKE 'X-%'
  ORDER BY InventoryValue DESC
`;

// ── DEMAND CLARITY QUERY ──────────────────────────────────────────────────────
// Shows items where QuantityDemand > 0, with open WO due dates to classify
// demand as near-term (WO due ≤30d), medium-term (31-90d), or long-horizon (90d+)
// QuantityReserved is confirmed zero in this instance so we focus on QuantityDemand
const DEMAND_CLARITY_QUERY = `
  SELECT
    i.PartNumber,
    i.Description,
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    ii.QuantityOnHand,
    ii.QuantityDemand,
    ii.QuantityWorkInProcess,
    ii.QuantityOrdered,
    ii.QuantityOnDock,
    ii.AverageCost,
    (ii.QuantityOnHand * NULLIF(ii.AverageCost,0))                      AS InventoryValue,
    -- True available ignoring all demand
    ii.QuantityOnHand                                                    AS TrueQOH,
    -- Demand-adjusted: subtract only near-term demand (WO due ≤30 days)
    ii.QuantityOnHand - ISNULL((
      SELECT SUM(wo.QuantityRequired)
      FROM WorkOrder wo
      WHERE wo.ItemFK = i.ItemPK
        AND wo.WorkOrderStatusFK = 2
        AND wo.DueDate <= DATEADD(day,30,GETDATE())
    ),0)                                                                 AS NearTermAdjustedQOH,
    -- Count of open WOs by horizon
    ISNULL((SELECT COUNT(*) FROM WorkOrder wo
      WHERE wo.ItemFK = i.ItemPK AND wo.WorkOrderStatusFK = 2
        AND wo.DueDate <= DATEADD(day,30,GETDATE())),0)                  AS WOsDueIn30d,
    ISNULL((SELECT COUNT(*) FROM WorkOrder wo
      WHERE wo.ItemFK = i.ItemPK AND wo.WorkOrderStatusFK = 2
        AND wo.DueDate > DATEADD(day,30,GETDATE())
        AND wo.DueDate <= DATEADD(day,90,GETDATE())),0)                  AS WOsDue31to90d,
    ISNULL((SELECT COUNT(*) FROM WorkOrder wo
      WHERE wo.ItemFK = i.ItemPK AND wo.WorkOrderStatusFK = 2
        AND wo.DueDate > DATEADD(day,90,GETDATE())),0)                   AS WOsBeyond90d,
    -- Earliest and latest WO due dates
    (SELECT MIN(wo.DueDate) FROM WorkOrder wo
      WHERE wo.ItemFK = i.ItemPK AND wo.WorkOrderStatusFK = 2)           AS EarliestWODue,
    (SELECT MAX(wo.DueDate) FROM WorkOrder wo
      WHERE wo.ItemFK = i.ItemPK AND wo.WorkOrderStatusFK = 2)           AS LatestWODue,
    ii.LastTransactionDate,
    i.LeadTime,
    i.ReorderPoint
  FROM Item i
  JOIN ItemInventory ii ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic     ON ic.ItemClassPK = i.ItemClassFK
  WHERE ii.QuantityDemand > 0
    AND i.Inventoriable = 1 AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%' AND ic.Code NOT LIKE 'X-%'
  ORDER BY (ii.QuantityOnHand * NULLIF(ii.AverageCost,0)) DESC
`;

// ── ROP RECOMMENDATION QUERY ──────────────────────────────────────────────────
// Calculates recommended reorder point based on 90-day consumption velocity
// Formula: DailyVelocity = UnitsConsumed90d / 90
//          LeadTimeDemand = DailyVelocity * LeadTimeDays
//          SafetyStock    = DailyVelocity * (LeadTimeDays * 0.5)
//          RecommendedROP = LeadTimeDemand + SafetyStock
// Only surfaces items where recommended ROP differs from current by >20%
const ROP_QUERY = `
  WITH Velocity AS (
    SELECT
      t.ItemFK,
      SUM(ABS(t.Quantity))                                               AS UnitsConsumed90d,
      SUM(ABS(t.Quantity)) / 90.0                                        AS DailyVelocity
    FROM ItemInventoryTransaction t
    WHERE t.TransactionDate >= DATEADD(day,-90,GETDATE())
      AND t.Quantity < 0   -- outbound/consumption transactions only
    GROUP BY t.ItemFK
  )
  SELECT TOP 200
    i.PartNumber,
    i.Description,
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    ii.QuantityOnHand,
    ii.AverageCost,
    i.ReorderPoint                                                       AS CurrentROP,
    i.MinimumQuantityOrder,
    i.MaximumQuantityOnHand,
    ISNULL(i.LeadTime, 14)                                               AS LeadTimeDays,
    ISNULL(v.DailyVelocity, 0)                                           AS DailyVelocity,
    ISNULL(v.UnitsConsumed90d, 0)                                        AS UnitsConsumed90d,
    -- Recommended ROP calculation
    ROUND(
      (ISNULL(v.DailyVelocity,0) * ISNULL(i.LeadTime,14)) +
      (ISNULL(v.DailyVelocity,0) * (ISNULL(i.LeadTime,14) * 0.5))
    , 0)                                                                 AS RecommendedROP,
    -- Safety stock component alone
    ROUND(ISNULL(v.DailyVelocity,0) * (ISNULL(i.LeadTime,14) * 0.5), 0) AS RecommendedSafetyStock,
    -- Gap between current and recommended
    ROUND(
      (ISNULL(v.DailyVelocity,0) * ISNULL(i.LeadTime,14)) +
      (ISNULL(v.DailyVelocity,0) * (ISNULL(i.LeadTime,14) * 0.5))
      - ISNULL(i.ReorderPoint,0)
    , 0)                                                                 AS ROPGap,
    -- Direction: TOO_LOW means current ROP understates need, TOO_HIGH means overstated
    CASE
      WHEN ISNULL(i.ReorderPoint,0) = 0 AND v.DailyVelocity > 0
        THEN 'NOT_SET'
      WHEN (
        (ISNULL(v.DailyVelocity,0) * ISNULL(i.LeadTime,14)) +
        (ISNULL(v.DailyVelocity,0) * (ISNULL(i.LeadTime,14) * 0.5))
      ) > ISNULL(i.ReorderPoint,0) * 1.2
        THEN 'TOO_LOW'
      WHEN (
        (ISNULL(v.DailyVelocity,0) * ISNULL(i.LeadTime,14)) +
        (ISNULL(v.DailyVelocity,0) * (ISNULL(i.LeadTime,14) * 0.5))
      ) < ISNULL(i.ReorderPoint,0) * 0.8
        THEN 'TOO_HIGH'
      ELSE 'OK'
    END                                                                  AS ROPStatus,
    ii.LastTransactionDate,
    i.EstimatedAnnualUsage
  FROM Item i
  JOIN ItemInventory ii ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic     ON ic.ItemClassPK = i.ItemClassFK
  LEFT JOIN Velocity v  ON v.ItemFK = i.ItemPK
  WHERE i.Inventoriable = 1 AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%' AND ic.Code NOT LIKE 'X-%'
    AND (
      -- Only show items where ROP needs attention
      ISNULL(i.ReorderPoint,0) = 0 AND v.DailyVelocity > 0
      OR ABS(
        ((ISNULL(v.DailyVelocity,0) * ISNULL(i.LeadTime,14)) +
         (ISNULL(v.DailyVelocity,0) * (ISNULL(i.LeadTime,14) * 0.5)))
        - ISNULL(i.ReorderPoint,0)
      ) > ISNULL(i.ReorderPoint,0) * 0.2
    )
  ORDER BY ABS(
    ((ISNULL(v.DailyVelocity,0) * ISNULL(i.LeadTime,14)) +
     (ISNULL(v.DailyVelocity,0) * (ISNULL(i.LeadTime,14) * 0.5)))
    - ISNULL(i.ReorderPoint,0)
  ) DESC
`;

// ── SALES QUERIES ─────────────────────────────────────────────────────────────

const SALES_SUMMARY_QUERY = `
  SELECT
    -- MTD
    SUM(CASE WHEN MONTH(i.CreateDate) = MONTH(GETDATE())
             AND YEAR(i.CreateDate) = YEAR(GETDATE())
             AND i.Credit = 0
             THEN i.TotalAmount ELSE 0 END)                            AS RevenueMTD,
    -- YTD
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE())
             AND i.Credit = 0
             THEN i.TotalAmount ELSE 0 END)                            AS RevenueYTD,
    -- Last Year Full
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE()) - 1
             AND i.Credit = 0
             THEN i.TotalAmount ELSE 0 END)                            AS RevenueLastYear,
    -- Same period last year YTD
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE()) - 1
             AND MONTH(i.CreateDate) <= MONTH(GETDATE())
             AND i.Credit = 0
             THEN i.TotalAmount ELSE 0 END)                            AS RevenueSamePeriodLY,
    -- Open orders value
    (SELECT SUM(sol.ExtendedAmount - sol.ShippedAmount)
     FROM SalesOrderLine sol
     JOIN SalesOrder so ON so.SalesOrderPK = sol.SalesOrderFK
     WHERE so.SalesOrderStatusFK = 2
       AND sol.SalesOrderLineStatusFK = 2)                             AS OpenOrderValue,
    -- Invoice count YTD
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE())
             AND i.Credit = 0
             THEN 1 ELSE 0 END)                                        AS InvoiceCountYTD,
    -- Unique customers YTD
    COUNT(DISTINCT CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE())
                        AND i.Credit = 0
                        THEN i.CustomerFK END)                         AS UniqueCustomersYTD
  FROM Invoice i
  WHERE i.InvoiceStatusFK IN (2, 5)
`;

const SALES_BY_DIVISION_QUERY = `
  SELECT
    ic.Code                                                            AS ClassCode,
    SUM(CASE WHEN MONTH(i.CreateDate) = MONTH(GETDATE())
             AND YEAR(i.CreateDate) = YEAR(GETDATE())
             THEN il.ExtendedAmount ELSE 0 END)                        AS RevenueMTD,
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE())
             THEN il.ExtendedAmount ELSE 0 END)                        AS RevenueYTD,
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE()) - 1
             THEN il.ExtendedAmount ELSE 0 END)                        AS RevenueLastYear,
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE()) - 1
             AND MONTH(i.CreateDate) <= MONTH(GETDATE())
             THEN il.ExtendedAmount ELSE 0 END)                        AS RevenueSamePeriodLY,
    COUNT(DISTINCT i.CustomerFK)                                       AS UniqueCustomersYTD,
    COUNT(DISTINCT i.InvoicePK)                                        AS InvoiceCountYTD
  FROM InvoiceLine il
  JOIN Invoice i    ON i.InvoicePK = il.InvoiceFK
  JOIN Item item    ON item.ItemPK = il.ItemFK
  JOIN ItemClass ic ON ic.ItemClassPK = item.ItemClassFK
  WHERE i.InvoiceStatusFK IN (2, 5)
    AND i.Credit = 0
    AND ic.Code NOT LIKE 'C-%'
    AND ic.Code NOT LIKE 'X-%'
  GROUP BY ic.Code
  ORDER BY RevenueYTD DESC
`;

const TOP_CUSTOMERS_QUERY = `
  SELECT TOP 50
    p.PartyPK,
    p.Name                                                             AS CustomerName,
    p.ShortName,
    SUM(CASE WHEN MONTH(i.CreateDate) = MONTH(GETDATE())
             AND YEAR(i.CreateDate) = YEAR(GETDATE())
             THEN i.TotalAmount ELSE 0 END)                            AS RevenueMTD,
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE())
             THEN i.TotalAmount ELSE 0 END)                            AS RevenueYTD,
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE()) - 1
             THEN i.TotalAmount ELSE 0 END)                            AS RevenueLastYear,
    COUNT(DISTINCT CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE())
                        THEN i.InvoicePK END)                          AS InvoicesYTD,
    MAX(i.CreateDate)                                                  AS LastInvoiceDate,
    DATEDIFF(day, MAX(i.CreateDate), GETDATE())                        AS DaysSinceLastOrder
  FROM Invoice i
  JOIN Party p ON p.PartyPK = i.CustomerFK
  WHERE i.InvoiceStatusFK IN (2, 5)
    AND i.Credit = 0
    AND YEAR(i.CreateDate) >= YEAR(GETDATE()) - 1
  GROUP BY p.PartyPK, p.Name, p.ShortName
  ORDER BY RevenueYTD DESC
`;

const INACTIVE_CUSTOMERS_QUERY = `
  SELECT TOP 100
    p.PartyPK,
    p.Name                                                             AS CustomerName,
    p.ShortName,
    MAX(i.CreateDate)                                                  AS LastInvoiceDate,
    DATEDIFF(day, MAX(i.CreateDate), GETDATE())                        AS DaysSinceLastOrder,
    SUM(CASE WHEN YEAR(i.CreateDate) = YEAR(GETDATE()) - 1
             THEN i.TotalAmount ELSE 0 END)                            AS RevenueLastYear,
    COUNT(DISTINCT i.InvoicePK)                                        AS TotalInvoicesLY
  FROM Invoice i
  JOIN Party p ON p.PartyPK = i.CustomerFK
  WHERE i.InvoiceStatusFK IN (2, 5)
    AND i.Credit = 0
  GROUP BY p.PartyPK, p.Name, p.ShortName
  HAVING MAX(i.CreateDate) < DATEADD(day, -60, GETDATE())
    AND MAX(i.CreateDate) >= DATEADD(year, -2, GETDATE())
  ORDER BY RevenueLastYear DESC
`;


function rollupSummary(records) {
  const divMap = {};
  for (const r of records) {
    const div = getDivision(r.ClassCode);
    if (!div) continue;
    if (!divMap[div]) {
      divMap[div] = {
        DivisionName: div,
        DivisionLabel: DIVISION_LABELS[div] || div,
        TotalParts: 0, TotalInventoryValue: 0,
        StockoutCount: 0, OverstockCount: 0, SlowMoverCount: 0,
      };
    }
    divMap[div].TotalParts          += r.TotalParts || 0;
    divMap[div].TotalInventoryValue += r.TotalInventoryValue || 0;
    divMap[div].StockoutCount       += r.StockoutCount || 0;
    divMap[div].OverstockCount      += r.OverstockCount || 0;
    divMap[div].SlowMoverCount      += r.SlowMoverCount || 0;
  }
  const sorted = CORE_DIVISIONS.filter(d => divMap[d]).map(d => divMap[d]);
  if (divMap['Other']) sorted.push(divMap['Other']);
  return sorted;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: 'ThermalMIETrakLive', timestamp: new Date().toISOString() });
});

app.get('/api/summary', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(SUMMARY_QUERY);
    res.json({ data: rollupSummary(result.recordset), timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stockouts', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(STOCKOUT_QUERY);
    res.json({ data: addDivision(result.recordset), timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Stockout error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/overstock', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(OVERSTOCK_QUERY);
    res.json({ data: addDivision(result.recordset), timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Overstock error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/slowmovers', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(SLOW_MOVER_QUERY);
    res.json({ data: addDivision(result.recordset), timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Slow movers error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/demand-clarity', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(DEMAND_CLARITY_QUERY);
    res.json({ data: addDivision(result.recordset), timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Demand clarity error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rop-recommendations', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(ROP_QUERY);
    res.json({ data: addDivision(result.recordset), timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('ROP recommendations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// All data in one call — used by AI analysis
app.get('/api/all', async (req, res) => {
  try {
    const p = await getPool();
    const [summaryRaw, stockoutsRaw, overstockRaw, slowMoversRaw, demandRaw, ropRaw] = await Promise.all([
      p.request().query(SUMMARY_QUERY),
      p.request().query(STOCKOUT_QUERY),
      p.request().query(OVERSTOCK_QUERY),
      p.request().query(SLOW_MOVER_QUERY),
      p.request().query(DEMAND_CLARITY_QUERY),
      p.request().query(ROP_QUERY),
    ]);
    res.json({
      summary:          rollupSummary(summaryRaw.recordset),
      stockouts:        addDivision(stockoutsRaw.recordset),
      overstock:        addDivision(overstockRaw.recordset),
      slowMovers:       addDivision(slowMoversRaw.recordset),
      demandClarity:    addDivision(demandRaw.recordset),
      ropRecommendations: addDivision(ropRaw.recordset),
      timestamp:        new Date().toISOString(),
    });
  } catch (err) {
    console.error('All data error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sales-summary', async (req, res) => {
  try {
    const p = await getPool();
    const [summary, byDiv] = await Promise.all([
      p.request().query(SALES_SUMMARY_QUERY),
      p.request().query(SALES_BY_DIVISION_QUERY),
    ]);
    const divData = byDiv.recordset.map(r => ({
      ...r,
      DivisionName: getDivision(r.ClassCode) || 'Other',
      DivisionLabel: DIVISION_LABELS[getDivision(r.ClassCode)] || r.ClassCode,
    }));
    res.json({
      summary: summary.recordset[0],
      byDivision: divData,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Sales summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/top-customers', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(TOP_CUSTOMERS_QUERY);
    res.json({ data: result.recordset, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Top customers error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inactive-customers', async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(INACTIVE_CUSTOMERS_QUERY);
    res.json({ data: result.recordset, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Inactive customers error:', err);
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ThermalInsight API  →  http://localhost:${PORT}`);
  console.log(`Database: ThermalMIETrakLive on THERMAL-ONE`);
});
