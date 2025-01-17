'use strict';

const path = require('path');
const cluster = require('cluster');
const fs = require('fs-extra');
const chokidar = require('chokidar');
const execa = require('execa');

const { logger } = require('strapi-utils');
const loadConfiguration = require('../core/app-configuration');
const strapi = require('../index');

const fetch = require('node-fetch');



/**
 * `$ strapi develop`
 *
 */
module.exports = async function({ build, watchAdmin, polling, browser }) {
  const dir = process.cwd();
  const config = loadConfiguration(dir);

  const adminWatchIgnoreFiles = config.get('server.admin.watchIgnoreFiles', []);
  const serveAdminPanel = config.get('server.admin.serveAdminPanel', true);

  const buildExists = fs.existsSync(path.join(dir, 'build'));
  // Don't run the build process if the admin is in watch mode
  if (build && !watchAdmin && serveAdminPanel && !buildExists) {
    try {
      execa.shellSync('npm run -s build -- --no-optimization', {
        stdio: 'inherit',
      });
    } catch (err) {
      process.exit(1);
    }
  }

  try {
    if (cluster.isMaster) {
      if (watchAdmin) {
        try {
          execa('npm', ['run', '-s', 'strapi', 'watch-admin', '--', '--browser', browser], {
            stdio: 'inherit',
          });
        } catch (err) {
          process.exit(1);
        }
      }

      cluster.on('message', (worker, message) => {
        switch (message) {
          case 'reload':
            logger.info('The server is restarting\n');
            worker.send('isKilled');
            break;
          case 'kill':
            worker.kill();
            cluster.fork();
            break;
          case 'stop':
            worker.kill();
            process.exit(1);
          default:
            return;
        }
      });

      cluster.fork();
    }

    if (cluster.isWorker) {
      const strapiInstance = strapi({
        dir,
        autoReload: true,
        serveAdminPanel: watchAdmin ? false : true,
      });

      watchFileChanges({
        dir,
        strapiInstance,
        watchIgnoreFiles: adminWatchIgnoreFiles,
        polling,
      });

      process.on('message', message => {
        switch (message) {
          case 'isKilled':
            strapiInstance.server.destroy(() => {
              process.send('kill');
            });
            break;
          default:
          // Do nothing.
        }
      });

      return strapiInstance.start();
    }
  } catch (e) {
    logger.error(e);
    process.exit(1);
  }
};

/**
 * Init file watching to auto restart strapi app
 * @param {Object} options - Options object
 * @param {string} options.dir - This is the path where the app is located, the watcher will watch the files under this folder
 * @param {Strapi} options.strapi - Strapi instance
 * @param {array} options.watchIgnoreFiles - Array of custom file paths that should not be watched
 */
function watchFileChanges({ dir, strapiInstance, watchIgnoreFiles, polling }) {
  const restart = () => {
    if (strapiInstance.reload.isWatching && !strapiInstance.reload.isReloading) {
      strapiInstance.reload.isReloading = true;
      strapiInstance.reload();
    }
  };
  

  const customWebhook = async() => {
    return await fetch(process.env.CUSTOM_WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify({
        commit: {
          author: process.env.CUSTOM_WEBHOOK_GIT_AUTHOR,
          email: process.env.CUSTOM_WEBHOOK_GIT_EMAIL,
          message: process.env.CUSTOM_WEBHOOK_GIT_MESSAGE,
        },
        local:{
          remote: process.env.CUSTOM_WEBHOOK_REPO_REMOTE,
          ref: process.env.CUSTOM_WEBHOOK_REPO_REF,
        },
        auth: {
          username: process.env.CUSTOM_WEBHOOK_AUTH_USERNAME,
          password: process.env.CUSTOM_WEBHOOK_AUTH_PASSWORD
        }
      }),
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
    
  }
  

  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    usePolling: polling,
    ignored: [
      /(^|[/\\])\../, // dot files
      /tmp/,
      '**/admin',
      '**/admin/**',
      'extensions/**/admin',
      'extensions/**/admin/**',
      '**/documentation',
      '**/documentation/**',
      '**/node_modules',
      '**/node_modules/**',
      '**/plugins.json',
      '**/index.html',
      '**/public',
      '**/public/**',
      '**/*.db*',
      '**/exports/**',
      ...watchIgnoreFiles,
    ],
  });

  watcher
    .on('add', async (path) => {
      strapiInstance.log.info(`File created: ${path}`);
      strapiInstance.log.info(`Custom webhook ready: ${process.env.CUSTOM_WEBHOOK_URL}`);
      if ( process.env.CUSTOM_WEBHOOK_URL )  {
        customWebhook();
      }
      strapiInstance.log.info(`Custom webhook complete: ${process.env.CUSTOM_WEBHOOK_URL}`);
      restart();
    })
    .on('change', async (path) => {
      strapiInstance.log.info(`File changed: ${path}`);
      strapiInstance.log.info(`Custom webhook ready: ${process.env.CUSTOM_WEBHOOK_URL}`);
      if ( process.env.CUSTOM_WEBHOOK_URL )  {
        customWebhook();
      }
      strapiInstance.log.info(`Custom webhook complete: ${process.env.CUSTOM_WEBHOOK_URL}`);
      restart();
    })
    .on('unlink', async (path) => {
      strapiInstance.log.info(`File deleted: ${path}`);
      strapiInstance.log.info(`Custom webhook ready: ${process.env.CUSTOM_WEBHOOK_URL}`);
      if ( process.env.CUSTOM_WEBHOOK_URL )  {
        customWebhook();
      }
      strapiInstance.log.info(`Custom webhook complete: ${process.env.CUSTOM_WEBHOOK_URL}`);
      restart();
    });
}
