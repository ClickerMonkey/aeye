#!/usr/bin/env node

/**
 * Update versions script for @aeye monorepo
 *
 * Updates all package versions and their @aeye/* dependencies to a specified version.
 *
 * Usage:
 *   node scripts/update-versions.js [version]
 *   npm run version:set -- [version]
 *
 * Examples:
 *   node scripts/update-versions.js          # Bumps to next patch version (e.g., 0.2.0 -> 0.2.1)
 *   node scripts/update-versions.js 1.0.0    # Sets version to 1.0.0
 *   node scripts/update-versions.js patch    # Bumps patch version
 *   node scripts/update-versions.js minor    # Bumps minor version
 *   node scripts/update-versions.js major    # Bumps major version
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

/**
 * Parse a semantic version string
 */
function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Bump version based on type
 */
function bumpVersion(currentVersion, type) {
  const version = parseVersion(currentVersion);

  switch (type) {
    case 'major':
      return `${version.major + 1}.0.0`;
    case 'minor':
      return `${version.major}.${version.minor + 1}.0`;
    case 'patch':
    default:
      return `${version.major}.${version.minor}.${version.patch + 1}`;
  }
}

/**
 * Get all package directories
 */
function getPackageDirs() {
  const packagesDir = path.join(__dirname, '..', 'packages');
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });

  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(packagesDir, entry.name))
    .filter(dir => fs.existsSync(path.join(dir, 'package.json')));
}

/**
 * Update package.json file
 */
function updatePackageJson(packagePath, newVersion) {
  const packageJsonPath = path.join(packagePath, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  const oldVersion = packageJson.version;
  packageJson.version = newVersion;

  // Update @aeye/* dependencies
  const depsUpdated = [];

  if (packageJson.dependencies) {
    for (const [dep, version] of Object.entries(packageJson.dependencies)) {
      if (dep.startsWith('@aeye/')) {
        const oldDep = version;
        // Preserve the range specifier (^, ~, etc.)
        const rangeMatch = version.match(/^([\^~])?/);
        const range = rangeMatch ? rangeMatch[1] || '' : '';
        packageJson.dependencies[dep] = `${range}${newVersion}`;
        depsUpdated.push({ dep, old: oldDep, new: packageJson.dependencies[dep] });
      }
    }
  }

  if (packageJson.devDependencies) {
    for (const [dep, version] of Object.entries(packageJson.devDependencies)) {
      if (dep.startsWith('@aeye/')) {
        const oldDep = version;
        const rangeMatch = version.match(/^([\^~])?/);
        const range = rangeMatch ? rangeMatch[1] || '' : '';
        packageJson.devDependencies[dep] = `${range}${newVersion}`;
        depsUpdated.push({ dep, old: oldDep, new: packageJson.devDependencies[dep] });
      }
    }
  }

  if (packageJson.peerDependencies) {
    for (const [dep, version] of Object.entries(packageJson.peerDependencies)) {
      if (dep.startsWith('@aeye/')) {
        const oldDep = version;
        const rangeMatch = version.match(/^([\^~])?/);
        const range = rangeMatch ? rangeMatch[1] || '' : '';
        packageJson.peerDependencies[dep] = `${range}${newVersion}`;
        depsUpdated.push({ dep, old: oldDep, new: packageJson.peerDependencies[dep] });
      }
    }
  }

  // Write back with pretty formatting
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + '\n',
    'utf8'
  );

  return { name: packageJson.name, oldVersion, newVersion, depsUpdated };
}

/**
 * Update root package.json
 */
function updateRootPackageJson(newVersion) {
  const rootPackageJsonPath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));

  const oldVersion = packageJson.version;
  packageJson.version = newVersion;

  fs.writeFileSync(
    rootPackageJsonPath,
    JSON.stringify(packageJson, null, 2) + '\n',
    'utf8'
  );

  return { oldVersion, newVersion };
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  let targetVersion = args[0];

  // Get current version from root package.json
  const rootPackageJsonPath = path.join(__dirname, '..', 'package.json');
  const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));
  const currentVersion = rootPackageJson.version;

  // Determine target version
  if (!targetVersion) {
    // Default to next patch version
    targetVersion = bumpVersion(currentVersion, 'patch');
    log(`\nNo version specified, bumping to next patch version: ${targetVersion}`, colors.cyan);
  } else if (targetVersion === 'patch' || targetVersion === 'minor' || targetVersion === 'major') {
    // Bump based on type
    targetVersion = bumpVersion(currentVersion, targetVersion);
    log(`\nBumping ${args[0]} version to: ${targetVersion}`, colors.cyan);
  } else {
    // Use specified version
    try {
      parseVersion(targetVersion); // Validate format
      log(`\nSetting version to: ${targetVersion}`, colors.cyan);
    } catch (error) {
      log(`\nError: ${error.message}`, colors.yellow);
      log('Usage: node scripts/update-versions.js [version|patch|minor|major]', colors.yellow);
      process.exit(1);
    }
  }

  log(`\nCurrent version: ${currentVersion}`, colors.blue);
  log(`Target version:  ${targetVersion}`, colors.green);

  // Update root package.json
  log(`\n${colors.bright}Updating root package.json...${colors.reset}`);
  const rootUpdate = updateRootPackageJson(targetVersion);
  log(`  ✓ ${rootUpdate.oldVersion} → ${rootUpdate.newVersion}`, colors.green);

  // Update all workspace packages
  log(`\n${colors.bright}Updating workspace packages...${colors.reset}`);
  const packageDirs = getPackageDirs();
  const updates = [];

  for (const packageDir of packageDirs) {
    const result = updatePackageJson(packageDir, targetVersion);
    updates.push(result);

    log(`\n  ${colors.bright}${result.name}${colors.reset}`, colors.cyan);
    log(`    Version: ${result.oldVersion} → ${result.newVersion}`, colors.green);

    if (result.depsUpdated.length > 0) {
      log(`    Dependencies updated:`, colors.blue);
      for (const dep of result.depsUpdated) {
        log(`      - ${dep.dep}: ${dep.old} → ${dep.new}`, colors.blue);
      }
    }
  }

  // Keep package-lock.json's workspace versions in step, so npm ci accepts it
  log(`\n${colors.bright}Refreshing package-lock.json...${colors.reset}`);
  require('child_process').execSync('npm install --package-lock-only --ignore-scripts', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });

  // Summary
  log(`\n${colors.bright}Summary:${colors.reset}`);
  log(`  ${colors.green}✓${colors.reset} Updated 1 root package`);
  log(`  ${colors.green}✓${colors.reset} Updated ${updates.length} workspace packages`);

  const totalDepsUpdated = updates.reduce((sum, u) => sum + u.depsUpdated.length, 0);
  if (totalDepsUpdated > 0) {
    log(`  ${colors.green}✓${colors.reset} Updated ${totalDepsUpdated} @aeye/* dependencies`);
  }

  log(`\n${colors.bright}${colors.green}Done! All packages updated to version ${targetVersion}${colors.reset}\n`);
  log(`Next steps:`, colors.cyan);
  log(`  1. Review the changes: ${colors.yellow}git diff${colors.reset}`);
  log(`  2. Commit the changes: ${colors.yellow}git add . && git commit -m "chore: bump version to ${targetVersion}"${colors.reset}`);
  log(`  3. Push, then tag: ${colors.yellow}git push && git tag v${targetVersion} && git push origin v${targetVersion}${colors.reset}`);
  log(`     The Release workflow publishes every package from the tag.\n`);
}

// Run the script
main();
