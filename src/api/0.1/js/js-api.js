'use strict';

const UTF8 = 'utf8';
const DOCKERFILE = 'Dockerfile';
const DOCKERFILE_NODE_LATEST = 'Dockerfile-node-14.04-4.2.3';
const DOCKERFILE_STATIC_LATEST = 'dockerfile-nginx-latest';
const SERVE_SH = 'serve.sh';
const DECRYPT_SH = 'decrypt.sh';
const DOCKER_BUILD_JS = 'docker-build.js';
const NOTIFY_JS = 'notify.js';
const CLUSTERNATOR_DIR = /\$CLUSTERNATOR_DIR/g;
const CLUSTERNATOR_PASS = /\$CLUSTERNATOR_PASS/g;
const PRIVATE_CHECKSUM = '.private-checksum';
const DEFAULT_API = /\$DEFAULT_API/g;
const HOST = /\$HOST/g;
const PROJECT_CREDS_FILE = 'aws-project-credentials.json';
const PROJECT_AWS_FILE = 'clusternator-aws.json';
const PROJECT_CN_CREDS_FILE = 'clusternator-project-credentials.json';

const Q = require('q');
const fs = require('fs');
const path = require('path');
const mkdirp = Q.nfbind(require('mkdirp'));

const cmn = require('../common');
const clusternatorJson = cmn.src('clusternator-json');
const Config = cmn.src('config');
const util = cmn.src('util');
const constants = cmn.src('constants');

const gpg = cmn.src('cli-wrappers', 'gpg');
const shaDir = cmn.src('cli-wrappers', 'generate-private-sha');
const git = cmn.src('cli-wrappers', 'git');
const docker = cmn.src('cli-wrappers', 'docker');

const appDefSkeleton = cmn.src('skeletons', 'app-def');

const userAPI = cmn.src('clusternator', 'user');
const cnProjectManager = cmn.src('clusternator', 'projectManager');
const awsProjectManager = cmn.src('aws', 'project-init');
const circle = cmn.src('circle-ci');

const writeFile = Q.nbind(fs.writeFile, fs);
const readFile = Q.nbind(fs.readFile, fs);
const chmod = Q.nbind(fs.chmod, fs);


module.exports = {
  getProjectRootRejectIfClusternatorJsonExists,
  installExecutable,
  installGitHook,
  provisionProjectNetwork,
  listSSHAbleInstances,
  getProjectAPI,
  generateDeploymentFromName,
  getSkeletonFile,
  initializeDeployments,
  initializeScripts,
  addPrivateToIgnore,
  initializeServeSh,
  privateChecksum,
  privateDiff,
  deploy,
  stop,
  update,
  startServer,
  initProject,
  makePrivate,
  readPrivate,
  dockerBuild,
  describeServices,
  listProjects,
  certUpload,
  certList,
  createUser,
  login,
  changePassword,
  generatePass: git.generatePass
};

function changePassword(username, password, newPassword, confirmPassword) {
  if (!username || !password) {
    return Q.reject(new Error('changePassword requires a username, and ' +
      'password'));
  }
  if (newPassword !== confirmPassword) {
    return Q.reject(new Error('password mismatch'));
  }
  userAPI.changePassword();
}

function login(username, password) {
  if (!username || !password) {
    return Q.reject(new Error('login requires password, and username'));
  }
  return userAPI.login(username, password);
}

function createUser(username, password, confirm, authority) {
  if (password !== password) {
    return Q.reject(new Error('password mismatch'));
  }
  return userAPI.create(username, password, confirm, authority);
}

/**
 * @returns {Q.Promise<string>}
 */
function getProjectRootRejectIfClusternatorJsonExists() {
  return clusternatorJson
    .findProjectRoot()
    .then((root) => clusternatorJson
      .skipIfExists(root)
      .then(() => root ));
}

function initializeSharedKey() {
  return gpg.generatePass();
}

function writeCreds(privatePath, creds) {
  util.info('NOTICE: Project Docker Credentials are being overwritten with ' +
    'new credentials, if there were previous credentials, they have been ' +
    'revoked. If you\'re reading this message, this will *not* impact you, ' +
    'however it *will* impact any other team members you\'re working with ' +
    'until your changes are committed to the master repo for this project');
  util.info('');
  return writeFile(
    path.join(privatePath, PROJECT_CREDS_FILE),
    JSON.stringify(creds, null, 2), UTF8);
}

function writeAws(privatePath, aws) {
  return writeFile(
    path.join(privatePath, PROJECT_AWS_FILE),
    JSON.stringify(aws, null, 2), UTF8);
}

function writeProjectDetails(privatePath, details) {
  return Q.all([
    writeCreds(privatePath, details.credentials),
    writeAws(privatePath, details.aws)
  ]);
}

function writeClusternatorCreds(privatePath, token) {
  return writeFile(path.join(privatePath, PROJECT_CN_CREDS_FILE),
    JSON.stringify({ token }, null, 2));
}

function provisionProjectNetwork(projectId, output, privatePath) {
  return getProjectAPI()
    .then((pm) =>  pm
      .create(projectId)
      .then((details) => writeProjectDetails(privatePath, details))
      .then(() => util
        .info(output + ' Network Resources Checked'))
      .then(() => pm
        .initializeGithubWebhookToken(projectId))
      .then((token) => writeClusternatorCreds(privatePath, token))
      .fail(Q.reject));
}

function installExecutable(destFilePath, fileContents, perms) {
  perms = perms || '700';
  return writeFile(destFilePath, fileContents).then(() => {
    return chmod(destFilePath, '700');
  });
}

function installGitHook(root, name, passphrase) {
  return getSkeletonFile('git-' + name)
    .then((contents) => {
      contents = contents.replace(CLUSTERNATOR_PASS, passphrase);
      return installExecutable(
        path.join(root, '.git', 'hooks', name), contents, 300);
    });
}


function getSkeletonPath() {
  return path.join(__dirname, '..', '..', '..', '..', 'src', 'skeletons');
}

/**
 * @param {string} skeleton
 * @return {Promise<string>}
 */
function getSkeletonFile(skeleton) {
  return readFile(path.join(getSkeletonPath(), skeleton) , UTF8);
}

/**
 * @param {string} ignoreFile
 * @param {string} privatePath
 * @returns {Q.Promise}
 */
function addPrivateToIgnore(ignoreFile, privatePath) {

  return clusternatorJson
    .readIgnoreFile(path.join(getSkeletonPath(), ignoreFile), true)
    .then((ignores) => ignores.concat(privatePath))
    .then((ignores) => clusternatorJson.addToIgnore(ignoreFile, ignores));
}

function writeDeployment(name, dDir, appDef) {
  return writeFile(path.join(dDir, name + '.json'), appDef);
}

function getProjectAPI() {
  var config = Config();

  if (config.awsCredentials) {
    return awsProjectManager(config);
  }
  return cnProjectManager(config);
}

function mapEc2ProjectDetails(instance) {
  var result = {
    type: 'type',
    identifier: '?',
    str: '',
    ip: '',
    state: ''
  }, inst, tags;
  if (!instance.Instances.length) {
    return result;
  }
  inst = instance.Instances[0];
  tags = inst.Tags;
  result.ip = inst.PublicIpAddress;
  result.state = inst.State.Name;

  tags.forEach((tag) => {
    if (tag.Key === constants.PR_TAG) {
      result.type = 'PR';
      result.identifier = tag.Value;
    }
    if (tag.Key === constants.DEPLOYMENT_TAG) {
      result.type = 'Deployment';
      result.identifier = tag.Value;
    }
  });

  result.str = `${result.type} ${result.identifier} ` +
    `(${result.ip}/${result.state})`;

  return result;
}

function listSSHAbleInstancesByProject(projectId) {
  return getProjectAPI()
    .then((pm) => pm
      .ec2
      .describeProject(projectId)
      .then((instances) => instances
        .map(mapEc2ProjectDetails)
      ));
}

function listSSHAbleInstances() {
  return clusternatorJson
    .get()
    .then((cJson) => listSSHAbleInstancesByProject(cJson.projectId));
}

function addPortsToAppDef(ports, appDef) {
  ports.forEach((port) => {
    appDef.tasks[0].containerDefinitions[0].portMappings.push({
      hostPort: port.portExternal,
      containerPort: port.portInternal,
      protocol: port.protocol
    });
  });
}


function generateDeploymentFromName(name, ports) {
  util.info('Generating deployment: ',  name);
  return clusternatorJson.get().then((config) => {
    var appDef = util.clone(appDefSkeleton);
    appDef.name = config.projectId;
    if (ports) {
      addPortsToAppDef(ports, appDef);
    }
    appDef = JSON.stringify(appDef, null, 2);
    return writeDeployment(name, config.deploymentsDir, appDef);
  });
}

/**
 * @param {string} clustDir
 * @param {string} tld
 * @returns {Q.promise}
 */
function initializeScripts(clustDir, tld) {
  return mkdirp(clustDir).then(() => {
    const decryptPath = path.join(clustDir, DECRYPT_SH),
      dockerBuildPath = path.join(clustDir, DOCKER_BUILD_JS),
      clusternatorPath = path.join(clustDir, NOTIFY_JS);

    return Q
      .allSettled([
        getSkeletonFile(DECRYPT_SH)
          .then((contents) => installExecutable(decryptPath, contents)),
        getSkeletonFile(DOCKER_BUILD_JS)
          .then((contents) => writeFile(dockerBuildPath, contents)),
        getSkeletonFile(NOTIFY_JS)
          .then((contents) => contents
            .replace(HOST, tld)
            .replace(DEFAULT_API, constants.DEFAULT_API_VERSION))
          .then((contents) => writeFile(clusternatorPath, contents))]);
  });
}

/**
 * @param {string} depDir
 * @param {string} projectId
 * @param {string} dockerType
 * @param {Object[]} ports
 * @returns {Q.Promise}
 */
function initializeDeployments(depDir, clustDir, projectId, dockerType, ports) {
  return mkdirp(depDir).then(() => {
    var prAppDef = util.clone(appDefSkeleton);
    prAppDef.name = projectId;
    addPortsToAppDef(ports, prAppDef);
    prAppDef = JSON.stringify(prAppDef, null, 2);

    return Q.allSettled([
      mkdirp(path.join(depDir, '..', constants.SSH_PUBLIC_PATH)),
      writeFile(path.join(depDir, 'pr.json'), prAppDef),
      writeFile(path.join(depDir, 'master.json'), prAppDef),
      initializeDockerFile(clustDir, dockerType)
    ]);
  });
}


function initializeDockerFile(clustDir, dockerType) {
  /** @todo do not overwrite existing Dockerfile */
  const template = dockerType === 'static' ?
    DOCKERFILE_STATIC_LATEST : DOCKERFILE_NODE_LATEST;
  return clusternatorJson
    .findProjectRoot()
    .then((root) => getSkeletonFile(template)
      .then((contents) => {
        contents = contents.replace(CLUSTERNATOR_DIR, clustDir);
        return writeFile(path.join(root, DOCKERFILE), contents);
      }) );
}

function initializeServeSh(root) {
  var sPath = path.join(root, SERVE_SH);
  return getSkeletonFile(SERVE_SH)
    .then((contents) => {
      return writeFile(sPath, contents);
    })
    .then(() => {
      return chmod(sPath, '755');
    });
}

function getPrivateChecksumPaths() {
  return Q.all([
      clusternatorJson.get(),
      clusternatorJson.findProjectRoot() ])
    .then((results) => {
      const privatePath = results[0].private,
        checksumPath = path.join(results[1], results[0].clusternatorDir,
          PRIVATE_CHECKSUM);
      return {
        priv: privatePath,
        checksum: checksumPath,
        clusternator: results[0].clusternatorDir,
        root: results[1]
      };
    });
}

function privateChecksum() {
  return getPrivateChecksumPaths()
    .then((paths) => {
      return mkdirp(paths.clusternator).then(() => paths);
    }).then((paths) => {
      process.chdir(paths.root);
      return paths;
    }).then((paths) =>shaDir
      .genSha(paths.priv)
      .then((sha) => writeFile(paths.checksum, sha)
        .then(() => util
          .info(`Generated shasum of ${paths.priv} => ${sha}`))))
    .done();
}

/**
 * @param {string} sha
 * @returns {Function}
 */
function getPrivateDiffFn(sha) {
  return (storedSha) => {
    if (sha.trim() === storedSha.trim()) {
      process.exit(0);
    }
    util.info(`Diff: ${sha.trim()} vs ${storedSha.trim()}`);
    process.exit(1);
  };
}

function privateDiff() {
  return getPrivateChecksumPaths()
    .then((paths) => shaDir
      .genSha(paths.priv)
      .then((sha) => readFile(paths.checksum, UTF8)
        .then(getPrivateDiffFn(sha))
        .fail(() => {
          // read file errors are expected
          util.info(`Diff: no checksum to compare against`);
          process.exit(2);
        })))
    .fail((err) => {
      // unexpected error case
      util.error(err);
      process.exit(2);
    })
    .done();
}

/**
 * @param {string} name
 * @returns {Request|Promise.<T>|*}
 */
function deploy(name) {
  return clusternatorJson
    .get()
    .then((cJson) => {
      var dPath = path.join(cJson.deploymentsDir, name + '.json');
      return Q
        .all([
          getProjectAPI(),
          git.shaHead(),
          readFile(dPath, UTF8)
            .fail(getAppDefNotFound(dPath))])
        .then((results) => deploy_(
          results[0], cJson, results[2], name, results[1]))
        .fail((err) => {
          util.info('Clusternator: Error creating deployment: ' + err.message);
          util.info(err.stack);
        });
    });
}

function stop(name, sha) {
  return clusternatorJson
    .get()
    .then((cJson) => Q
      .all([
        getProjectAPI(),
        git.shaHead()])
      .then((results) => {
        sha = sha || results[1];
        util.info('Stopping Deployment...: ', cJson.projectId, ': ', name,
          ' sha: ', sha);
        return results[0].destroyDeployment(
          cJson.projectId,
          name,
          sha
        );
      }).fail((err) => {
        util.info('Clusternator: Error stopping deployment: ' + err.message);
        util.info(err.stack);
      })
    );
}

function update(name) {
  return clusternatorJson
    .get()
    .then((cJson) => {
      var dPath = path.join(cJson.deploymentsDir, name + '.json');
      return Q
        .all([
          getProjectAPI(),
          git.shaHead(),
          readFile(dPath, UTF8)
            .fail(getAppDefNotFound(dPath))])
        .then((results) => {
          var projectAPI = results[0];
          var sha = sha || results[1];
          var appDefStr = results[2];

          return update_(projectAPI, cJson, appDefStr, name, sha);
        }).fail((err) => {
          //util.info('Clusternator: Error stopping deployment: ' + err.message);
          //util.info(err.stack);
          console.log('ERR', err.stack);
        });
      });
}


function startServer(config) {
  const server = cmn.src('server', 'main');
  return server.startServer(config);
}

/**
 * @param {ProjectManager} pm
 * @param {Object} cJson
 * @param {string} appDefStr
 * @param {string} deployment
 * @param {string} sha
 * @returns {Request|Promise.<T>}
 * @private
 */
function deploy_(pm, cJson, appDefStr, deployment, sha) {
  util.info('Requirements met, creating deployment...');
  var appDef = util.safeParse(appDefStr);
  if (!appDef) {
    throw new Error('Deployment failed, error parsing appDef');
  }
  const config = Config();
  return pm.createDeployment(
    cJson.projectId,
    deployment,
    sha,
    appDef,
    config.useInternalSSL || false
  ).then((result) => {
    util.info('Deployment will be available at ', result);
  });
}

/**
 * @param {ProjectManager} pm
 * @param {Object} cJson
 * @param {string} appDefStr
 * @param {string} deployment
 * @param {string} sha
 * @returns {Request|Promise.<T>}
 * @private
 */
function update_(pm, cJson, appDefStr, deployment, sha) {
  util.info('Updating deployment...');
  var appDef = util.safeParse(appDefStr);
  if (!appDef) {
    throw new Error('Deployment failed, error parsing appDef');
  }

  return pm.updateDeployment(
    cJson.projectId,
    deployment,
    sha,
    appDef
  ).then((result) => {
    util.info('Deployment updated', result);
  }, (err) => {
    return Q.reject(err);
  });
}

function getAppDefNotFound(dPath) {
  return (err) => {
    util.info(`Deployment AppDef Not Found In: ${dPath}: ${err.message}`);
    throw err;
  };
}

function logKey(sharedKey) {
  console.log('');
  console.log('Share this *SECRET* key with your team members');
  console.log('Also use it as CLUSTERNATOR_SHARED_KEY on CircleCi');
  console.log(`CLUSTERNATOR_SHARED_KEY ${sharedKey}`);
  console.log('');
}

/**
 * @param {string} root
 * @param {{ deploymentsDir: string, clusternatorDir: string,
 projectId: string, backend: string, tld: string, circleCi: boolean }} options
 * @param skipNetwork
 * @returns {Request|Promise.<T>|*}
 */
function initProject(root, options, skipNetwork) {
  var output = 'Clusternator Initialized With Config: ' +
      clusternatorJson.fullPath(root),
    dDir = options.deploymentsDir,
    cDir = options.clusternatorDir,
    projectId = options.projectId,
    dockerType = options.backend;

  return Q
    .allSettled([
      initializeDeployments(dDir, cDir, projectId, dockerType, options.ports),
      initializeScripts(cDir, options.tld),
      initializeOptionalDeployments(options, root)])
    .then(() => {
      if (skipNetwork) {
        util.info(output + ' Network Resources *NOT* Checked');
        return;
      }

      return provisionProjectNetwork(projectId, output, options.private)
        .then(initializeSharedKey)
        .then((sharedKey) => makePrivate(sharedKey)
          .then(() => readPrivate(sharedKey))
          .then(privateChecksum)
          .then(() => logKey(sharedKey)));
    });
}

/**
 * @param {{ deploymentsDir: string, clusternatorDir: string,
 projectId: string, backend: string, tld: string, circleCi: boolean }} options
 * @param {string} projectRoot
 * @returns {Request|Promise.<T>|*}
 */
function initializeOptionalDeployments(options, projectRoot) {
  let promises = [];

  if (options.circleCI) {
    promises.push(circle.init(projectRoot, options.clusternatorDir));
  }
  if (options.backend === 'node') {
    promises.push(initializeServeSh(
      path.join(projectRoot, options.clusternatorDir)));
  }
  return Q.allSettled(promises);
}


function dockerBuild(name, passphrase) {
  return makePrivate(passphrase).then(() => {
    return clusternatorJson
      .findProjectRoot()
      .then((root) => {
        var output, outputError;
        process.chdir(root);
        util.info('Start Docker Build', name);
        return docker.build(name)
          .progress((data) => {
            if (!data) {
              return;
            }
            if (data.error) {
              outputError += data.error;
              util.error(outputError);
            }
            if (data.data) {
              output += data.data;
              util.verbose(output);
            }
          });
      })
      .then(() => {
        util.verbose('Decrypting Private Folder');
        return readPrivate(passphrase);
      })
      .then(() => {
        util.info('Built Docker Image: ', name);
      })
      .fail((err) => {
        util.warn('Docker failed to build: ', err.message);
        return readPrivate(passphrase);
      });
  });
}

function makePrivate(passphrase) {
  return clusternatorJson
    .makePrivate(passphrase)
    .then(() => {
      util.info('Clusternator: Private files/directories encrypted');
    });
}

function readPrivate(passphrase) {
  return clusternatorJson.readPrivate(passphrase).then(() => {
    util.info('Clusternator: Private files/directories un-encrypted');
  });
}

function listProjects() {
  return getProjectAPI()
    .then((pm) => pm
      .listProjects());
}

function describeServices() {
  return getProjectAPI()
    .then((pm) => clusternatorJson
      .get()
      .then((config) => pm
        .describeProject(config.projectId)));
}


/**
 * @param {string} privateKey
 * @param {string} certificate
 * @param {string=} chain
 * @return {Q.Promise}
 */
function loadCertificateFiles(privateKey, certificate, chain) {
  var filePromises = [
    readFile(privateKey, UTF8),
    readFile(certificate, UTF8)
  ];
  if (chain) {
    filePromises.push(readFile(chain, UTF8));
  }
  return Q
    .all(filePromises)
    .then((results) => {
      return {
        privateKey: results[0],
        certificate: results[1],
        chain: results[2] || ''
      };
    });
}

/**
 * @param {string} privateKey
 * @param {string} certificate
 * @param {string} certId
 * @param {string=} chain
 * @return {Q.Promise}
 */
function certUpload(privateKey, certificate, certId, chain) {
  return loadCertificateFiles(privateKey, certificate, chain)
  .then((certs) => getProjectAPI()
    .then((pm) => pm.iam
      .uploadServerCertificate(
        certs.certificate, certs.privateKey, certs.chain, certId)));
}

function certList() {
  return getProjectAPI()
    .then((pm) => pm.iam
      .listServerCertificates());
}
