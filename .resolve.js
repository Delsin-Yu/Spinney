const fs = require('fs');
function patch(file, pairs) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let s = raw.replace(/\r\n/g, '\n');
  for (const [from, to] of pairs) {
    if (!s.includes(from)) throw new Error('missing in ' + file + ': ' + from.slice(0, 70));
    s = s.replace(from, to);
  }
  fs.writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s);
  console.log('patched ' + file);
}
const pairs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
patch(process.argv[2], pairs);
