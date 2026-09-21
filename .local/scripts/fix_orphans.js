const fs = require('fs');
const list1 = 'crd-list.csv';
const list2 = 'crd-list-generic.csv';

const orphans = {
    '6597789': 'MICHAEL CHOI',
    '2614915': 'JOHN JOSEPH KILLIAN'
};

const lines1 = fs.readFileSync(list1, 'utf8').split('\n');
const lines2 = fs.readFileSync(list2, 'utf8').split('\n');

const out1 = fs.createWriteStream(list1);
out1.write(lines1[0] + '\n');

const out2 = fs.createWriteStream(list2);
out2.write(lines2[0] + '\n');

for (let i = 1; i < lines1.length; i++) {
    const line = lines1[i];
    if (!line) continue;
    const parts = line.split(',');
    const crd = parts[1];
    if (orphans[crd]) {
        // write to generic list
        out2.write(`${parts[0]},${crd},"${orphans[crd]}",false,false,false\n`);
    } else {
        out1.write(line + '\n');
    }
}

for (let i = 1; i < lines2.length; i++) {
    const line = lines2[i];
    if (!line) continue;
    const parts = line.split(',');
    const crd = parts[1];
    if (orphans[crd]) {
        // already handled
    } else {
        out2.write(line + '\n');
    }
}

out1.end();
out2.end();
