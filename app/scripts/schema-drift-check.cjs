#!/usr/bin/env node
const { Client } = require("pg");

const PROD_DATABASE_URL = process.env.PROD_DATABASE_URL || process.env.PRODUCTION_DATABASE_URL;
const STAGING_DATABASE_URL = process.env.STAGING_DATABASE_URL;
const TABLES = ["users", "driver_details", "customer_profiles", "vehicles", "documents", "driver_documents"];

if (!PROD_DATABASE_URL || !STAGING_DATABASE_URL) {
  console.error("Missing PROD_DATABASE_URL or STAGING_DATABASE_URL");
  process.exit(1);
}

async function connect(connectionString) {
  const client = new Client({
    connectionString,
    ssl: connectionString.includes("sslmode=require") ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function loadSchema(client) {
  const tables = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name
    `,
    [TABLES],
  );

  const columns = await client.query(
    `
      SELECT
        table_name,
        column_name,
        is_nullable,
        data_type,
        udt_name,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `,
    [TABLES],
  );

  const indexes = await client.query(
    `
      SELECT
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename, indexname
    `,
    [TABLES],
  );

  const fks = await client.query(
    `
      SELECT
        tc.table_name,
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ANY($1::text[])
      ORDER BY tc.table_name, tc.constraint_name
    `,
    [TABLES],
  );

  return {
    tables: tables.rows.map((row) => row.table_name),
    columns: columns.rows,
    indexes: indexes.rows,
    fks: fks.rows,
  };
}

function byTable(rows, key = "table_name") {
  return rows.reduce((acc, row) => {
    const table = row[key];
    if (!acc[table]) acc[table] = [];
    acc[table].push(row);
    return acc;
  }, {});
}

function diffNamedCollections(prodRows, stagingRows, formatter) {
  const prodSet = new Set(prodRows.map(formatter));
  const stagingSet = new Set(stagingRows.map(formatter));
  const missingInStaging = [...prodSet].filter((item) => !stagingSet.has(item));
  const missingInProd = [...stagingSet].filter((item) => !prodSet.has(item));
  return { missingInStaging, missingInProd };
}

async function main() {
  const prod = await connect(PROD_DATABASE_URL);
  const staging = await connect(STAGING_DATABASE_URL);

  try {
    const [prodSchema, stagingSchema] = await Promise.all([loadSchema(prod), loadSchema(staging)]);
    const report = [];

    const tableDiff = diffNamedCollections(
      prodSchema.tables.map((name) => ({ name })),
      stagingSchema.tables.map((name) => ({ name })),
      (row) => row.name,
    );
    if (tableDiff.missingInStaging.length || tableDiff.missingInProd.length) {
      report.push({ scope: "tables", ...tableDiff });
    }

    const prodColumns = byTable(prodSchema.columns);
    const stagingColumns = byTable(stagingSchema.columns);
    const prodIndexes = byTable(prodSchema.indexes, "tablename");
    const stagingIndexes = byTable(stagingSchema.indexes, "tablename");
    const prodFks = byTable(prodSchema.fks);
    const stagingFks = byTable(stagingSchema.fks);

    for (const table of TABLES) {
      const colDiff = diffNamedCollections(
        prodColumns[table] || [],
        stagingColumns[table] || [],
        (row) => `${row.column_name}|${row.data_type}|${row.udt_name}|${row.is_nullable}|${row.column_default || ""}`,
      );
      const idxDiff = diffNamedCollections(
        prodIndexes[table] || [],
        stagingIndexes[table] || [],
        (row) => row.indexdef,
      );
      const fkDiff = diffNamedCollections(
        prodFks[table] || [],
        stagingFks[table] || [],
        (row) => `${row.constraint_name}|${row.column_name}|${row.foreign_table_name}|${row.foreign_column_name}`,
      );

      if (colDiff.missingInProd.length || colDiff.missingInStaging.length) {
        report.push({ scope: `columns:${table}`, ...colDiff });
      }
      if (idxDiff.missingInProd.length || idxDiff.missingInStaging.length) {
        report.push({ scope: `indexes:${table}`, ...idxDiff });
      }
      if (fkDiff.missingInProd.length || fkDiff.missingInStaging.length) {
        report.push({ scope: `foreign_keys:${table}`, ...fkDiff });
      }
    }

    if (!report.length) {
      console.log("Schema drift check passed: production and staging match for audited tables.");
      return;
    }

    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  } finally {
    await Promise.allSettled([prod.end(), staging.end()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
