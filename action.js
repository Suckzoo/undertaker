const AWS = require('aws-sdk');
const target = require('./target.json');


function flatten(arr) {
  let result = [];
  arr.forEach(x => {
    if (x instanceof Array) {
      result.push(...flatten(x));
    } else {
      result.push(x);
    }
  });
  return result;
}

module.exports = async (config) => {
  const ELBv2 = new AWS.ELBv2({
    region: target.region
  });

  // Part A. destroy ELBs
  let instances = [];
  if (target.elb) {
    // Step 1. elb from name
    console.log("Step 1: fetching ELBs");
    let Names = target.elb instanceof Array ? target.elb : [ target.elb ];
    let params = {
      Names
    };
    let loadBalancers = await ELBv2.describeLoadBalancers(params).promise();
    loadBalancers = loadBalancers.LoadBalancers;
    loadBalancers.forEach(lb => {
      console.log(lb.LoadBalancerArn);
    })
    if (loadBalancers.length) {
      // Step 2. target groups(instances) from elb
      console.log("Step 2-1: fetching target groups behind ELBs");
      let promises = loadBalancers.map(async lb => {
        let params = {
          LoadBalancerArn: lb.LoadBalancerArn
        }
        let tg = await ELBv2.describeTargetGroups(params).promise();
        return tg.TargetGroups.map(_tg => _tg.TargetGroupArn);
      });
      let targetGroupArns = await Promise.all(promises);
      targetGroupArns = flatten(targetGroupArns);
      console.log(targetGroupArns);

      console.log("Step 2-2: fetching instances of each target groups");
      promises = targetGroupArns.map(async TargetGroupArn => {
        let params = {
          TargetGroupArn
        }
        let health = await ELBv2.describeTargetHealth(params).promise();
        return health.TargetHealthDescriptions;
      });
      let targetHealths = await Promise.all(promises);
      targetHealths = flatten(targetHealths);
      console.log(targetHealths);
      targetHealths.forEach(th => {
        instances.push(th.Target.Id);
      });
      if (config.real) {
        // Step 3. delete elb itself
        console.log("Step 3: destory ELBs");
        promises = loadBalancers.map(lb => {
          let params = {
            LoadBalancerArn: lb.LoadBalancerArn
          };
          return ELBv2.deleteLoadBalancer(params).promise();
        })
        await Promise.all(promises);
        // Step 4. delete target groups
        console.log("Step 4: destory orphaned target groups");
        promises = targetGroupArns.map(TargetGroupArn => {
          let params = {
            TargetGroupArn
          };
          return ELBv2.deleteTargetGroup(params).promise();
        });
        await Promise.all(promises);
      } else {
        console.log("Step 3: destory ELBs... SKIPPED");
        console.log("Step 4: destory orphaned target groups... SKIPPED");
      }
    }
    console.log("Custom target instances: ");
    console.log(target.instances);
    console.log("Target instances: ");
    instances.push(...target.instances);
    console.log(instances);
  }
}
