const fs = require("fs");
const path = require("path");

const target = process.argv[2];
const allowed = new Set(["local", "staging", "production"]);

if (!allowed.has(target)) {
  console.error("Usage: node scripts/use-env.cjs <local|staging|production>");
  process.exit(1);
}

const root = process.cwd();
const sourcePath = path.join(root, `.env.${target}`);
const destPath = path.join(root, ".env");

if (!fs.existsSync(sourcePath)) {
  console.error(`Missing ${sourcePath}`);
  process.exit(1);
}

fs.copyFileSync(sourcePath, destPath);
console.log(`Activated environment: ${target}`);
console.log(`Copied ${path.basename(sourcePath)} -> .env`);
