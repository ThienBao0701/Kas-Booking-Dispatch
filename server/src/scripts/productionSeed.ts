/**
 * CLI: `npm run prod:seed`
 *
 * Idempotent production bootstrap — branches + platform hotel names only.
 * Never creates operational or demo data. Safe to run on every deploy.
 */
import { prisma } from '../db/prisma';
import { runProductionSeed } from '../production/productionSeed';

/* eslint-disable no-console */
async function main(): Promise<void> {
  const result = await runProductionSeed();

  console.log('✅ Seed cấu hình production hoàn tất.');
  console.log(`   Chi nhánh:            ${result.branches}`);
  console.log(`   Tên nền tảng (tổng):  ${result.aliasesTotal} (mới tạo: ${result.aliasesCreated})`);
  console.log('   Dữ liệu vận hành:     ' + JSON.stringify(result.operational));

  for (const warning of result.warnings) {
    console.warn(`⚠️  ${warning}`);
  }
  // Demo data or the test account in a production database is a hard stop.
  if (result.operational.demoBookings > 0 || result.testReceptionistPresent) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      console.error('Seed production thất bại:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
