const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });
const exe = path.join(out, process.platform === 'win32' ? 'amdinfer-service.exe' : 'amdinfer-service');
execFileSync(process.execPath, [
  path.join(root, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js'),
  path.join(root, 'server.js'), '--out-path', out, '--target', 'node22-' + process.platform + '-' + process.arch
], { stdio: 'inherit', cwd: root });
const generated = path.join(out, process.platform === 'win32' ? 'server.exe' : 'server');
if (fs.existsSync(generated) && generated !== exe) {
  if (fs.existsSync(exe)) fs.unlinkSync(exe);
  fs.renameSync(generated, exe);
}
if (!fs.existsSync(exe)) throw new Error('Packaged service was not generated. Check @yao-pkg/pkg output.');
console.log(`Packaged service: ${exe}`);
