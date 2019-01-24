const readline = require('readline');
const action = require('./action');

let config = {
  real: false
};
process.argv.forEach(v => {
  v.replace(/--/g, '');
  config[v] = true;
});

if (process.apply) {
  const r = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  r.question("WARNING: resources will be permanently deleted. Are you sure? (y/n):", answer => {
    if (answer.toLowerCase() === 'y') {
      execute(config);
    } else if (answer.toLowerCase() === 'n') {
      console.log('Abort.');
    } else {
      console.log('Invalid input');
    }
  })
} else {
  execute(config);
}

function execute() {
  action(config).then(_ => {
    console.log('Done');
  }).catch(err => {
    console.log('FAILED!!!!!!!!');
    console.error(err);
  });
}
