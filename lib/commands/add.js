/**
 * aiyu-multi-agent add skill <name> — Install a skill plugin from npm
 */

const chalk = require("chalk");
const ora = require("ora");
const fs = require("fs");
const path = require("path");

const config = require("../core/config");
const plugin = require("../core/plugin");
const H = require("../core/hermes-theme");

async function run(type, name, options = {}) {
  if (type !== "skill") {
    console.log(H.style.statusWarn(`\n  Only "skill" type is supported currently. Usage: aiyu-multi-agent add skill <name>\n`));
    return;
  }

  const projectDir = process.cwd();

  if (!config.configExists(projectDir)) {
    console.log(H.style.error("No config directory found. Run `aiyu-multi-agent init` first.\n"));
    return;
  }

  // Phase 1: Download + validate
  const spinner = ora(`Installing skill: ${name}...`).start();

  try {
    const skillName = plugin.install(projectDir, name);
    spinner.succeed(H.style.statusGood(`Skill "${skillName}" installed!`));

    const skillDir = plugin.getSkillDir(projectDir, skillName);

    // Phase 2: Permission check
    const permResult = await plugin.checkPermissions(skillDir, { autoApprove: options.autoApprove });
    if (!permResult.granted) {
      // Rollback — remove the skill
      plugin.remove(projectDir, skillName);
      console.log(H.style.statusWarn("\n  Permission denied. Skill not installed.\n"));
      return;
    }

    // Show skill info
    console.log(`\n  ${H.style.dim("Installed to:")} ${H.style.text(skillDir)}`);

    const skillMd = path.join(skillDir, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, "utf-8");
      const descMatch = content.match(/description:\s*(.+)/);
      if (descMatch) {
        console.log(`  ${H.style.dim("Description:")} ${H.style.text(descMatch[1].trim())}`);
      }
    }

    // Show granted permissions
    const grantedPerms = Object.keys(permResult.permissions);
    if (grantedPerms.length > 0) {
      console.log(`  ${H.style.dim("Permissions:")} ${H.style.text(grantedPerms.join(", "))}`);
    }

    console.log(`\n  ${H.style.dim("The skill is now available for your agents.")}`);
    console.log(`  ${H.style.dim("Reference it in agent frontmatter: skills: ..., " + skillName)}\n`);
  } catch (err) {
    spinner.fail(H.style.error(`Failed to install skill: ${name}`));
    console.error(H.style.error(`  ${err.message}\n`));
  }
}

module.exports = { run };
