'use strict';

var Subnet = require('./subnetManager'),
  Route = require('./routeTableManager'),
  Route53 = require('./route53Manager'),
  Vpc = require('./vpcManager'),
  Acl = require('./aclManager'),
  Cluster = require('./clusterManager'),
  Pr = require('./prManager'),
  Deployment = require('./deploymentManager'),
  Q = require('q');

function getProjectManager(ec2, ecs, awsRoute53) {
  var vpcId = null,
    pullRequest,
    cluster,
    deployment,
    vpc = Vpc(ec2),
    r53 = Route53(awsRoute53),
    route,
    subnet,
    acl;

  function destroy(pid) {
    return ec2.describeProject(pid).then((list) => {
      if (list.length) {
        throw new Error('ProjectManager: Cannot destroy project while open ' +
          'pull requests exist');
      }
      return subnet.destroy(pid).then(() => {
          return acl.destroy(pid);
      });
    });
  }

  /**
   * @param {string} pid
   * @returns {Request|Promise.<T>}
   */
  function create(pid) {
    return Q.all([
      route.findDefault(),
      acl.create(pid)
    ]).then((results) => {
      var routeId = results[0].RouteTableId,
        aclId = results[1].NetworkAcl.NetworkAclId;

      return subnet.create(pid, routeId, aclId);
    });
  }

  /**
   * @param {string} pid
   * @returns {Request}
   */
  function findOrCreateProject(pid) {
    return create(pid).then((sDesc) => {
      return sDesc;
    }, () => {
      return subnet.findProject();
    });
  }

  /**
   * @param {string} pid
   * @param {string} pr
   * @param {Object} appDef
   * @returns {Q.Promise}
   */
  function createPR(pid, pr, appDef) {
    return findOrCreateProject(pid).then((snDesc) => {
      return pullRequest.create(pid, pr, appDef);
    });
  }

  /**
   * @param {string} pid
   * @param {string} dep
   * @param {string} sha
   * @param {Object} appDef
   * @returns {Q.Promise}
   */
  function createDeployment(pid, dep, sha, appDef) {
    return findOrCreateProject(pid).then((snDesc) => {
      return deployment.create( pid, dep, sha, appDef );
    });
  }

  /**
   * @param {string} pid
   * @param {string} dep
   * @param {string} sha
   * @returns {Request}
   */
  function destroyDeployment(pid, dep, sha) {
    return findOrCreateProject(pid).then((snDesc) => {
      return deployment.destroy( pid, dep, sha);
    });
  }

  function describeProject(pid) {
    return cluster.describeProject(pid);
  }


  return Q.all([
     vpc.findProject(),
     r53.findId()
  ]).then((results) => {
    var vDesc = results[0],
    zoneId = results[1];

    cluster = Cluster(ecs);
    vpcId = vDesc.VpcId;
    route = Route(ec2, vpcId);
    subnet = Subnet(ec2, vpcId);
    acl = Acl(ec2, vpcId);
    pullRequest = Pr(ec2, ecs, awsRoute53, vpcId, zoneId);
    deployment = Deployment(ec2, ecs, awsRoute53, vpcId, zoneId);
    return {
      create,
      createPR,
      createDeployment,
      destroy,
      destroyDeployment,
      describeProject
    };
  });


}

module.exports = getProjectManager;