const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: [
    'https://warm-naiad-8914d4.netlify.app',
    'http://localhost',
    'null',
  ],
  methods: ['GET'],
}));
app.use(express.json());

// ── Database Configuration ──────────────────────────────────────────────────
const dbConfig = {
  user: 'ThermalInsightReader',
  password: 'TIReader2024!',
  server: 'THERMAL-ONE',              // Replace with external IP/hostname from Meriplex
  database: 'ThermalMIETrakLive',     // Confirmed database name
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
  if (!pool) {
    pool = await sql.connect(dbConfig);
  }
  return pool;
}

// ── Division Grouping ────────────────────────────────────────────────────────
// Maps ItemClass codes to their parent product division.
// Consigned (C-) and Expensed (X-) classes are excluded from core analysis.
const CLASS_TO_DIVISION = {
  'TS':   'TS',
  'TSFG': 'TS',
  'BH':   'BH',
  'BHFG': 'BH',
  'CH':   'CH',
  'CHFG': 'CH',
  'KB':   'KB',
  'RE':   'RE',
  'NB':   'NB',
  'NBFG': 'NB',
  'FB':   'FB',
  'MOS':  'Other',
  'UN':   'Other',
};

const CORE_DIVISIONS = ['TS', 'BH', 'CH', 'KB', 'RE', 'NB', 'FB'];

const DIVISION_LABELS = {
  'TS': 'Temperature Sensors',
  'BH': 'Band Heaters',
  'CH': 'Cartridge Heaters',
  'KB': 'Knuckle Band',
  'RE': 'Resale',
  'NB': 'Nozzle Band',
  'FB': 'SOTAMB',
  'Other': 'Other',
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

// ── Queries ──────────────────────────────────────────────────────────────────

const SUMMARY_QUERY = `
  SELECT
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    COUNT(DISTINCT i.ItemPK)                                             AS TotalParts,
    SUM(ii.QuantityOnHand * NULLIF(ii.AverageCost, 0))                  AS TotalInventoryValue,
    SUM(CASE WHEN ii.QuantityOnHand <= 0
             AND i.ReorderPoint > 0 THEN 1 ELSE 0 END)                  AS StockoutCount,
    SUM(CASE WHEN i.MaximumQuantityOnHand > 0
             AND ii.QuantityOnHand > i.MaximumQuantityOnHand
             THEN 1 ELSE 0 END)                                          AS OverstockCount,
    SUM(CASE WHEN ii.QuantityOnHand > 0
             AND (ii.LastTransactionDate IS NULL
                  OR ii.LastTransactionDate < DATEADD(day, -90, GETDATE()))
             THEN 1 ELSE 0 END)                                          AS SlowMoverCount
  FROM Item i
  JOIN ItemInventory ii   ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic       ON ic.ItemClassPK = i.ItemClassFK
  WHERE i.Inventoriable = 1
    AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%'
    AND ic.Code NOT LIKE 'X-%'
  GROUP BY ic.Code, ic.Name
  ORDER BY ic.Code
`;

const STOCKOUT_QUERY = `
  SELECT TOP 300
    i.PartNumber,
    i.Description,
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    ii.QuantityOnHand,
    i.ReorderPoint,
    ii.QuantityOrdered,
    ii.QuantityOnDock,
    ii.LastTransactionDate,
    ii.AverageCost,
    ii.LastSellDate,
    ii.LastSellPrice
  FROM Item i
  JOIN ItemInventory ii   ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic       ON ic.ItemClassPK = i.ItemClassFK
  WHERE ii.QuantityOnHand <= 0
    AND i.ReorderPoint > 0
    AND i.Inventoriable = 1
    AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%'
    AND ic.Code NOT LIKE 'X-%'
  ORDER BY i.ReorderPoint DESC
`;

const OVERSTOCK_QUERY = `
  SELECT TOP 300
    i.PartNumber,
    i.Description,
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    ii.QuantityOnHand,
    i.MaximumQuantityOnHand,
    i.ReorderPoint,
    ii.AverageCost,
    (ii.QuantityOnHand - i.MaximumQuantityOnHand)                       AS ExcessQty,
    ((ii.QuantityOnHand - i.MaximumQuantityOnHand) * ii.AverageCost)    AS ExcessValue,
    ii.LastTransactionDate
  FROM Item i
  JOIN ItemInventory ii   ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic       ON ic.ItemClassPK = i.ItemClassFK
  WHERE i.MaximumQuantityOnHand > 0
    AND ii.QuantityOnHand > i.MaximumQuantityOnHand
    AND i.Inventoriable = 1
    AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%'
    AND ic.Code NOT LIKE 'X-%'
  ORDER BY ExcessValue DESC
`;

const SLOW_MOVER_QUERY = `
  SELECT TOP 300
    i.PartNumber,
    i.Description,
    ic.Code                                                              AS ClassCode,
    ic.Name                                                              AS ClassName,
    ii.QuantityOnHand,
    ii.AverageCost,
    ii.StandardCost,
    (ii.QuantityOnHand * NULLIF(ii.AverageCost, 0))                     AS InventoryValue,
    ii.LastTransactionDate,
    DATEDIFF(day, ii.LastTransactionDate, GETDATE())                     AS DaysSinceLastTransaction,
    i.EstimatedAnnualUsage,
    ii.LastSellDate
  FROM Item i
  JOIN ItemInventory ii   ON ii.ItemInventoryPK = i.ItemInventoryFK
  JOIN ItemClass ic       ON ic.ItemClassPK = i.ItemClassFK
  WHERE ii.QuantityOnHand > 0
    AND (
      ii.LastTransactionDate IS NULL
      OR ii.LastTransactionDate < DATEADD(day, -90, GETDATE())
    )
    AND i.Inventoriable = 1
    AND i.OnHold = 0
    AND ic.Code NOT LIKE 'C-%'
    AND ic.Code NOT LIKE 'X-%'
  ORDER BY InventoryValue DESC
`;

// ── Summary rollup helper ────────────────────────────────────────────────────
function rollupSummary(records) {
  const divMap = {};
  for (const r of records) {
    const div = getDivision(r.ClassCode);
    if (!div) continue;
    if (!divMap[div]) {
      divMap[div] = {
        DivisionName: div,
        DivisionLabel: DIVISION_LABELS[div] || div,
        TotalParts: 0,
        TotalInventoryValue: 0,
        StockoutCount: 0,
        OverstockCount: 0,
        SlowMoverCount: 0,
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

// ── Routes ───────────────────────────────────────────────────────────────────

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

app.get('/api/all', async (req, res) => {
  try {
    const p = await getPool();
    const [summaryRaw, stockoutsRaw, overstockRaw, slowMoversRaw] = await Promise.all([
      p.request().query(SUMMARY_QUERY),
      p.request().query(STOCKOUT_QUERY),
      p.request().query(OVERSTOCK_QUERY),
      p.request().query(SLOW_MOVER_QUERY),
    ]);
    res.json({
      summary:    rollupSummary(summaryRaw.recordset),
      stockouts:  addDivision(stockoutsRaw.recordset),
      overstock:  addDivision(overstockRaw.recordset),
      slowMovers: addDivision(slowMoversRaw.recordset),
      timestamp:  new Date().toISOString(),
    });
  } catch (err) {
    console.error('All data error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ThermalInsight API  →  http://localhost:${PORT}`);
  console.log(`Database: ThermalMIETrakLive on THERMAL-ONE`);
  console.log(`Health:   http://localhost:${PORT}/api/health`);
});
