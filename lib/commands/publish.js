/**
 * aiyu-multi-agent publish — Publish agent to npm
 */

const chalk = require("chalk");
const ora = require("ora");
const fs = require("fs");

const config = require("../core/config");
const validator = require("../publish/validator");
const packager = require("../publish/packager");
const registry = require("../publish/registry");
const H = require("../core/hermes-theme");

async function run(options = {}) {
  const projectDir = process.cwd();

  if (!config.configExists(projectDir)) {
    console.log(H.style.error("No config directory found. Run `aiyu-multi-agent init` first.\n"));
    return;
  }

  // Step 1: Validate
  const spinner = ora("Validating agent...").start();
  const validation = validator.validate(projectDir);

  if (!validation.valid) {
    spinner.fail(H.style.error("Validation failed"));
    console.log(H.style.error("\n  Errors:"));
    validation.errors.forEach(e => console.log(H.style.statusBad(`    ✗ ${e}`)));
    if (validation.warnings.length > 0) {
      console.log(H.style.statusWarn("\n  Warnings:"));
      validation.warnings.forEach(w => console.log(H.style.statusWarn(`    ⚠ ${w}`)));
    }
    console.log("");
    return;
  }

  if (validation.warnings.length > 0) {
    spinner.warn(H.style.statusWarn("Validation passed with warnings"));
    validation.warnings.forEach(w => console.log(H.style.statusWarn(`    ⚠ ${w}`)));
  } else {
    spinner.succeed(H.style.statusGood("Validation passed"));
  }

  // Step 2: Check npm login
  const user = registry.whoami();
  if (!user) {
    console.log(H.style.error("\n  Not logged in to npm. Run `npm login` first.\n"));
    return;
  }
  console.log(H.style.dim(`  Publishing as: ${user}`));

  // Step 3: Package
  const pkgSpinner = ora("Packaging agent...").start();
  let pkgResult;
  try {
    pkgResult = packager.packageAgent(projectDir, {
      name: options.name,
      version: options.version,
      author: options.author,
      license: options.license,
    });
    pkgSpinner.succeed(H.style.statusGood(`Packaged: ${pkgResult.pkgName}@${pkgResult.pkgVersion}`));
  } catch (err) {
    pkgSpinner.fail(H.style.error("Packaging failed"));
    console.error(H.style.error(`  ${err.message}\n`));
    return;
  }

  // Step 4: Publish
  if (options.dryRun) {
    console.log(H.style.accent(`\n  [DRY RUN] Would publish: ${pkgResult.pkgName}@${pkgResult.pkgVersion}`));
    console.log(H.style.dim(`  Run without --dry-run to actually publish.\n`));
    try { fs.rmSync(pkgResult.tmpDir, { recursive: true, force: true }); } catch {}
    return;
  }

  const pubSpinner = ora(`Publishing ${pkgResult.pkgName}@${pkgResult.pkgVersion}...`).start();
  const result = registry.publish(pkgResult.tmpDir, {
    access: options.access || "public",
    tag: options.tag,
  });

  if (result.success) {
    pubSpinner.succeed(H.style.statusGood(`Published: ${pkgResult.pkgName}@${pkgResult.pkgVersion}`));
    console.log(`\n  ${H.style.dim("Install with:")} ${H.style.accent("npx " + pkgResult.pkgName)}`);
    console.log(`  ${H.style.dim("npm page:")}   ${H.style.accent("https://www.npmjs.com/package/" + pkgResult.pkgName)}\n`);
  } else {
    pubSpinner.fail(H.style.error("Publish failed"));
    console.error(H.style.error(`  ${result.error}\n`));
  }

  // Cleanup temp dir
  try {
    fs.rmSync(pkgResult.tmpDir, { recursive: true, force: true });
  } catch {}
}

module.exports = { run };
