const path = require("node:path");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

(async () => {
  const { assertSchemaObjectsOrThrow } = await import("../server/schema-health.ts");
  await assertSchemaObjectsOrThrow({
    tables: ["franchisees", "franchise_payouts", "franchise_service_assignments"],
    columns: [
      {
        table: "franchisees",
        columns: [
          "commission_type", "commission_flat", "address", "city", "pincode",
          "bank_name", "bank_account", "bank_ifsc", "gst_number", "pan_number",
          "agreement_date", "contract_end_date", "min_guaranteed", "payout_cycle",
          "total_paid_out", "notes", "photo_url", "whatsapp", "alt_contact_name",
          "alt_contact_phone", "franchise_type", "service_area_desc", "website",
          "bank_holder_name", "state",
        ],
      },
    ],
  });
  console.log("franchise schema OK");
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
