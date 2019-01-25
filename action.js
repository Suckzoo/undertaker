const AWS = require('aws-sdk');
const child_process = require('child_process');
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
  const EC2 = new AWS.EC2({
    apiVersion: '2016-11-15',
    region: target.region
  })

  // Part A. destroy ELBs
  let instances = [];
  let vpcs = [];
  if (target.elb && target.elb.length) {
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
      console.log("Step 2-0: extract VPC from ELBs");
      vpcs = loadBalancers.map(lb => lb.VpcId);
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
      if (config.apply) {
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
        let elapsed = 0;
        while (targetGroupArns.length > 0) {
          promises = targetGroupArns.map(async TargetGroupArn => {
            try {
              let params = {
                TargetGroupArn
              };
              await ELBv2.deleteTargetGroup(params).promise();
              return true;
            } catch (err) {
              if (err.code === 'ResourceInUse') return false;
              throw err;
            }
          });
          let result = await Promise.all(promises);
          result.forEach((v, i) => {
            if (v) {
              targetGroupArns.splice(i, 1);
            }
          });
          child_process.execSync("sleep 5");
          elapsed += 5;
          console.log(`Retrying... (${targetGroupArns.length} groups left, ${elapsed}s)`)
        }
      } else {
        console.log("Step 3: destory ELBs... SKIPPED");
        console.log("Step 4: destory orphaned target groups... SKIPPED");
      }
    }
  }
  console.log("Custom target instances: ");
  console.log(target.instances);
  console.log("Target instances: ");
  instances.push(...target.instances);
  console.log(instances);
  // Part B. terminating EC2 instances
  params = {
    InstanceIds: instances
  };
  console.log("Step 5: Extract VPCs and Security Groups from EC2 instances");
  if (instances.length) {
    instances = await EC2.describeInstances(params).promise();
    instances = instances.Reservations.map(reserve => reserve.Instances[0]);
    vpcs.push(...instances.map(instance => instance.VpcId));
  }
  vpcs = Array.from(new Set(vpcs)); // duplication removal
  console.log("VPC ID: ");
  console.log(vpcs);
  if (config.apply) {
    console.log("Step 6: Terminating EC2 instances");
    if (instances.length) {
      let params = {
        InstanceIds: instances.map(i => i.InstanceId)
      };
      await EC2.terminateInstances(params).promise()
      console.log("Termination requested.");
      let elapsed = 0;
      while (instances.length) {
        console.log(`Waiting for termination... (${instances.length} instance(s) remaining..., ${elapsed}s)`)
        let params = {
          InstanceIds: instances.map(i => i.InstanceId)
        };
        let desc = await EC2.describeInstances(params).promise();
        desc = desc.Reservations.map(reserve => reserve.Instances[0]);
        instances = desc.filter(i => i.State.Name !== 'terminated');
        child_process.execSync("sleep 5");
        elapsed += 5;
      }
    } else {
      console.log("No instances running. SKIPPED");
    }
  } else {
    console.log("Step 6: Terminating EC2 instances... SKIPPED");
  }
  console.log("Every instances terminated.");

  if (config.ignoreVpc) {
    console.log("VPC destruction skipped due to configurated values.");
    return;
  }

  // Part C. freeing VPC resources
  // FUCK THIS SHIT
  console.log("Step 7: Fetching VPC resources");
  console.log("Step 7-1: Fetching IGW");
  let filter = {
    Name: "attachment.vpc-id",
    Values: vpcs
  }
  let Filters = [ filter ];
  params = { Filters };
  let igws = await EC2.describeInternetGateways(params).promise();
  igws = igws.InternetGateways.map(i => i.InternetGatewayId);
  console.log(igws);
  console.log("Step 7-2: Fetching ENI");
  filter.Name = 'vpc-id';
  let enis = await EC2.describeNetworkInterfaces(params).promise();
  enis = enis.NetworkInterfaces.map(e => e.NetworkInterfaceId);
  console.log(enis);
  console.log("Step 7-3: Fetching Route Tables");
  let rts = await EC2.describeRouteTables(params).promise();
  rts = rts.RouteTables.map(r => r.RouteTableId);
  console.log(rts);
  console.log("Step 7-4: Fetching Subnets");
  let subnets = await EC2.describeSubnets(params).promise();
  subnets = subnets.Subnets.map(r => r.SubnetId);
  console.log(subnets);
  console.log("Step 7-5: Fetching Security Groups");
  let securityGroups = await EC2.describeSecurityGroups(params).promise();
  securityGroups = securityGroups.SecurityGroups.filter(sg => sg.GroupName !== 'default');
  console.log(securityGroups.map(sg => sg.GroupName));
  securityGroups = securityGroups.map(s => s.GroupId);
  console.log(securityGroups);
  console.log("Step 7-6: Fetching Network ACLs");
  let acls = await EC2.describeNetworkAcls(params).promise();
  acls = acls.NetworkAcls.filter(a => !a.IsDefault);
  acls = acls.map(a => a.NetworkAclId);
  console.log(acls);
  if (config.apply) {
    console.log("Step 8. Destroy VPC Resources");
    let promises;
    console.log("Deleting Subnets...");
    if (subnets.length) {
      promises = subnets.map(async SubnetId => {
        let params = {
          SubnetId
        };
        return await EC2.deleteSubnet(params).promise();
      });
      await Promise.all(promises);
    }
    console.log("Deleting SGs...");
    if (securityGroups.length) {
      promises = securityGroups.map(async GroupId => {
        let params = {
          GroupId
        };
        return await EC2.deleteSecurityGroup(params).promise();
      });
      await Promise.all(promises);
    }
    console.log("Deleting ENIs...");
    if (enis.length) {
      promises = enis.map(async NetworkInterfaceId => {
        let params = {
          NetworkInterfaceId
        };
        return await EC2.deleteNetworkInterface(params).promise();
      });
      await Promise.all(promises);
    }
    console.log("Deleting Routing Tables...");
    if (rts.length) {
      promises = rts.map(async RouteTableId => {
        let params = {
          RouteTableId
        };
        return await EC2.deleteRouteTable(params).promise();
      });
      await Promise.all(promises);
    }
    console.log("Deleting IGWs...");
    if (igws.length) {
      promises = igws.map(async InternetGatewayId => {
        let params = {
          InternetGatewayId
        };
        return await EC2.deleteInternetGateway(params).promise();
      });
      await Promise.all(promises);
    }
    console.log("Deleting ACLs...");
    if (acls.length) {
      promises = acls.map(async NetworkAclId => {
        let params = {
          NetworkAclId
        };
        return await EC2.deleteNetworkAcl(params).promise();
      });
      await Promise.all(promises);
    }
    console.log("Deleting VPC...");
    promises = vpcs.map(async VpcId => {
      let params = {
        VpcId
      };
      return await EC2.deleteVpc(params).promise();
    });
    await Promise.all(promises);
  } else {
    console.log("Step 8. Destroy VPC Resources... SKIPPED");
  }
}
