const readline = require('readline');
const action = require('./action');

let config = {
  apply: false
};
process.argv.forEach(v => {
  v = v.replace(/--/g, '');
  config[v] = true;
});

if (config.apply) {
  const r = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  r.question("WARNING: resources will be permanently deleted. Are you sure? (y/n):", answer => {
    if (answer.toLowerCase() === 'y') {
      execute(config);
    } else if (answer.toLowerCase() === 'n') {
      console.log('Abort.');
      process.exit(0);
    } else {
      console.log('Invalid input');
      process.exit(0);
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
    process.exit(1);
  });
}
