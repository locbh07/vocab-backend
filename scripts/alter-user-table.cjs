const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Altering useraccount table...');
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE useraccount
      ADD COLUMN IF NOT EXISTS level VARCHAR(10),
      ADD COLUMN IF NOT EXISTS google_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS auth_user_id VARCHAR(255);
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS useraccount_google_id_key ON useraccount(google_id);
      CREATE UNIQUE INDEX IF NOT EXISTS useraccount_auth_user_id_key ON useraccount(auth_user_id);
    `);
    console.log('Schema updated successfully!');
  } catch (error) {
    console.error('Error altering table:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
