import {
  endGroup,
  error,
  getInput,
  startGroup,
  info,
  warning,
} from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import fetch from 'node-fetch';
import { existsSync, rmSync } from 'node:fs';

(async () => {
  // check if the runner operating system is windows
  if (process.platform !== 'win32') {
    error('This action only works on Windows.');
    process.exit(1);
  }

  // get the inputs from the action
  const pkgid = getInput('identifier');
  const version = getInput('version');
  const instRegex = getInput('installers-regex');
  const releaseRepository = getInput('release-repository');
  const releaseTag = getInput('release-tag');
  const maxVersionsToKeep = Number(getInput('max-versions-to-keep'));
  const token = getInput('token');
  const forkUser = getInput('fork-user');

  const github = getOctokit(token);

  // check if at least one version of the package is already present in winget-pkgs repository
  fetch(
    `https://github.com/microsoft/winget-pkgs/tree/master/manifests/${pkgid
      .charAt(0)
      .toLowerCase()}/${pkgid.replaceAll('.', '/')}`,
    { method: 'HEAD' },
  ).then((res) => {
    if (!res.ok) {
      error(
        `Package ${pkgid} does not exist in the winget-pkgs repository. Please add atleast one version of the package before using this action.`,
      );
      process.exit(1);
    }
  });

  // check if max-versions-to-keep is a valid number and is 0 (keep all versions) or greater than 0
  if (!Number.isInteger(maxVersionsToKeep) || maxVersionsToKeep < 0) {
    error(
      'Invalid input supplied: max-versions-to-keep should be 0 (zero - keep all versions) or a positive integer.',
    );
    process.exit(1);
  }

  // fetch komac.jar from the latest release
  execSync(
    `Invoke-WebRequest -Uri https://github.com/russellbanks/Komac/releases/download/v1.4.1/Komac-1.4.1-all.jar -OutFile komac.jar`,
    {
      shell: 'pwsh',
      stdio: 'inherit',
    },
  );

  // get release information using the release tag
  const releaseInfo = {
    ...(
      await github.rest.repos.getReleaseByTag({
        owner: context.repo.owner,
        repo: releaseRepository,
        tag: releaseTag,
      })
    ).data, // get only data, and exclude status, url, and headers
  };

  startGroup('Updating manifests and creating pull request...');
  const pkgVersion =
    version || new RegExp(/(?<=v).*/g).exec(releaseInfo.tag_name)![0];
  const installerUrls = releaseInfo.assets
    .filter((asset) => {
      return new RegExp(instRegex, 'g').test(asset.name);
    })
    .map((asset) => {
      return asset.browser_download_url;
    });

  // set github token environment variable, and execute komac to update the manifest and submit the pull request
  process.env.KMC_CRTD_WITH = `WinGet Releaser ${process.env.GITHUB_ACTION_REF}`;
  process.env.KMC_FRK_OWNER = forkUser;
  process.env.GITHUB_TOKEN = token;
  const command = `-jar komac.jar update --id \'${pkgid}\' --version ${pkgVersion} --urls \'${installerUrls.join(
    ',',
  )}\' --submit`;
  info(`Executing command: java ${command}`);
  execSync(`& $env:JAVA_HOME_17_X64\\bin\\java.exe ${command}`, {
    shell: 'pwsh',
    stdio: 'inherit',
  });
  endGroup();

  // get the list of existing versions of the package using wingetdev
  let existingVersions: string[] = (
    await (
      await fetch(
        `https://winget-manifests-manager.vercel.app/api/get-winget-packages`,
      )
    ).json()
  )[pkgid]
    .sort()
    .reverse();

  // if maxVersionsToKeep is not 0, and no. of existing versions is greater than maxVersionsToKeep,
  // delete the older versions (starting from the oldest version)
  startGroup(
    'Checking for deleting old versions with respect to max-versions-to-keep...',
  );

  info(`Number of existing versions: ${existingVersions.length}`);
  info(
    `Number of versions to keep: ${maxVersionsToKeep}${
      maxVersionsToKeep === 0 ? ' (unlimited)' : ''
    }`,
  );

  if (
    maxVersionsToKeep === 0 ||
    existingVersions.length + 1 < maxVersionsToKeep
  ) {
    info('Result: No versions will be deleted.');
    endGroup();
  } else {
    // remove the newer versions from the list of existing versions
    // the left over versions will be deleted
    for (let iterator = 0; iterator < maxVersionsToKeep; iterator++)
      existingVersions.shift();

    info(
      `Result: ${
        existingVersions.length
      } versions will be deleted (${existingVersions.join(', ')}).`,
    );
    endGroup();

    // check if winget-pkgs already exists, and delete it if it does
    if (existsSync('winget-pkgs')) {
      rmSync('winget-pkgs', { recursive: true, force: true });
    }

    // clone the winget-pkgs repository, and configure remotes
    startGroup('Cloning winget-pkgs repository...');
    execSync(
      `git clone https://x-access-token:${token}@github.com/microsoft/winget-pkgs.git`,
      { stdio: 'inherit' },
    );
    execSync(`git -C winget-pkgs config --local user.name github-actions`, {
      stdio: 'inherit',
    });
    execSync(
      `git -C winget-pkgs config --local user.email 41898282+github-actions[bot]@users.noreply.github.com`,
      { stdio: 'inherit' },
    );
    execSync(`git -C winget-pkgs remote rename origin upstream`, {
      stdio: 'inherit',
    });
    execSync(
      `git -C winget-pkgs remote add origin https://github.com/${forkUser}/winget-pkgs.git`,
      { stdio: 'inherit' },
    );
    endGroup();

    startGroup('Deleting old versions...');
    // build the path to the package directory (e.g. manifests/m/Microsoft/OneDrive)
    const pkgDir = join(
      'manifests',
      `${pkgid[0].toLowerCase()}`,
      `${pkgid.replace('.', '/')}`,
    );

    // iterate over the left over versions and delete them
    existingVersions.forEach(async (version) => {
      if (existsSync(join('winget-pkgs', pkgDir, version)) === false) {
        info(`Version ${version} does not exist. Skipping and moving on...`);
        return;
      }

      info(`Deleting version ${version}...`);
      execSync(`git -C winget-pkgs fetch upstream master`, {
        stdio: 'inherit',
      });
      execSync(
        `git -C winget-pkgs checkout -b ${pkgid}-v${version}-REMOVE upstream/master`,
        {
          stdio: 'inherit',
        },
      );
      rmSync(join('winget-pkgs', pkgDir, version), {
        recursive: true,
        force: true,
      });
      execSync(
        `git -C winget-pkgs commit --all -m \"Remove: ${pkgid} version ${version}\"`,
        { stdio: 'inherit' },
      );
      execSync(`git -C winget-pkgs push origin ${pkgid}-v${version}-REMOVE`, {
        stdio: 'inherit',
      });
      info(
        `Pull request created: ${
          (
            await github.rest.pulls.create({
              owner: 'microsoft',
              repo: 'winget-pkgs',
              title: `Remove: ${pkgid} version ${version}`,
              head: `${forkUser}:${pkgid}-v${version}-REMOVE`,
              base: 'master',
              body:
                '### Reason for removal: This version is older than what has been set in `max-versions-to-keep` by the publisher.\n\n' +
                '#### Pull request has been automatically created using 🛫 [WinGet Releaser](https://github.com/vedantmgoyal2009/winget-releaser).',
            })
          ).data.html_url
        }`,
      );
      execSync(`git -C winget-pkgs checkout master`, { stdio: 'inherit' });
    });
    endGroup();
  }

  // check for action updates, and create a pull request if there are any
  startGroup('Checking for action updates...');
  const latestVersion = (
    await github.rest.repos.getLatestRelease({
      owner: 'vedantmgoyal2009',
      repo: 'winget-releaser',
    })
  ).data.tag_name;

  info(`Current action version: ${process.env.GITHUB_ACTION_REF}`);
  info(`Latest version found: ${latestVersion}`);

  if (latestVersion > process.env.GITHUB_ACTION_REF!) {
    warning(
      `Please update the action to the latest version (${latestVersion}) by changing the version in the workflow file. You can also use GitHub Dependabot (https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot) to do it automatically in the future.`,
    );
  } else {
    info(`No updates found. Bye bye!`);
  }
  endGroup();
})();
