const fs = require('fs');
let b = fs.readFileSync('server/ai.ts', 'utf8');
b = b.replace('drizzle-orm";`nimport', 'drizzle-orm";\nimport');
fs.writeFileSync('server/ai.ts', b);
console.log('Fixed');
