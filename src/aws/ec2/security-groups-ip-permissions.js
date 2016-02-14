'use strict';
/**
 * Types for managing AWS EC2 SecurityGroups IP Permissions
 *
 * @module aws/ec2/sg/ipPermissions
 */

module.exports = {
  create: SgIpPermissions
};

const validProtocols = Object.freeze([-1, '-1', 'tcp', 'udp', 'icmp']);

/**
 * @param {string} protocol
 * @param {number} fromPort
 * @param {number} toPort
 * @param {SgIpRange[]|SgUserIdGroupPair[]} ipRangesOrSgs
 * @throws {TypeError}
 * @constructor
 */
function SgIpPermissions(protocol, fromPort, toPort, ipRangesOrSgs) {
  if (!(this instanceof SgIpPermissions)) {
    return new SgIpPermissions(protocol, fromPort, toPort, ipRangesOrSgs);
  }
  this.IpProtocol = this.validateProtocol(protocol);
  this.FromPort = fromPort;
  this.ToPort = toPort;
  if (this.validateIpRangeOrSgs(ipRangesOrSgs) === 'ip') {
    this.IpRanges = ipRangesOrSgs;
  } else {
    this.UserIdGroupPairs = ipRangesOrSgs;
  }
}

/**
 * @param {string|number} protocol
 * @returns {boolean}
 */
SgIpPermissions.prototype.validateProtocol = function(protocol) {
  return validProtocols.indexOf(protocol) !== -1;
};

/**
 * @param {SgIpRange|SgUserIdGroupPair} ipRangeOrSg
 * @returns {string}
 * @throws {TypeError}
 */
SgIpPermissions.prototype.detectIpRangeOrSg = function(ipRangeOrSg) {
  let type = '';
  if (ipRangeOrSg.CidrIp) {
    type = 'ip';
  }
  if (ipRangeOrSg.GroupId) {
    type = 'sg';
  }
  if (!type) {
    throw new TypeError('SgIpPermission expecting ip range, or security ' +
      'group');
  }
  return type;
};

/**
 * @param {string} prev
 * @param {SgIpRange|SgUserIdGroupPair} current
 * @returns {string}
 * @throws {TypeError}
 */
SgIpPermissions.prototype.reduceIpRangeOrSgs = function(prev, current) {
  if (!prev) {
    return this.detectIpRangeOrSg(current);
  }
  const cType = this.detectIpRangeOrSg(current);
  if (cType === prev) {
    return cType;
  }
  throw new TypeError('SgIpPermissions must be entirely ip ranges, or ' +
    'security groups');
};

/**
 * @param {SgIpRange[]|SgUserIdGroupPair[]} ipRangesOrSgs
 * @returns {string}
 * @throws {TypeError}
 */
SgIpPermissions.prototype.validateIpRangeOrSgs = function(ipRangesOrSgs) {
  if (!Array.isArray(ipRangesOrSgs)) {
    throw new TypeError('SgIpPermissions expecting array of ip ranges, or ' +
      'security groups');
  }
  return ipRangesOrSgs.reduce(this.reduceIpRangeOrSgs.bind(this));
};

