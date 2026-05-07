/**
 * aiyu-multi-agent remove skill <name> — Uninstall a skill plugin
 */

const chalk = require("chalk");
const ora = require("ora");

const config = require("../core/config");
const plugin = require("../core/plugin");
const H = require("../core/hermes-theme");

async function run(type, name, options = {}) {
  if (type !== "skill") {
    console.log(H.style.statusWarn(`\n  Only "skill" type is supported currently. Usage: aiyu-multi-agent remove skill <name>\n`));
    return;
  }

  const projectDir = process.cwd();

  if (!config.configExists(projectDir)) {
    console.log(H.style.error("No config directory found.\n"));
    return;
  }

  if (!plugin.isInstalled(projectDir, name)) {
    console.log(H.style.statusWarn(`Skill "${name}" is not installed.\n`));
    console.log(H.style.accent("Installed skills:"));
    const installed = plugin.listInstalled(projectDir);
    if (installed.length === 0) {
      console.log("  (none)");
    } else {
      installed.forEach(s => console.log(`  ${H.style.text(s)}`));
    }
    console.log("");
    return;
  }

  const spinner = ora(`Removing skill: ${name}...`).start();

  try {
    const skillName = plugin.remove(projectDir, name);
    spinner.succeed(H.style.statusGood(`Skill "${skillName}" removed!`));
    console.log(`\n  ${H.style.dim("Remember to update any agent frontmatter that referenced this skill.")}\n`);
  } catch (err) {
    spinner.fail(H.style.error(`Failed to remove skill: ${name}`));
    console.error(H.style.error(`  ${err.message}\n`));
  }
}

module.exports = { run };
