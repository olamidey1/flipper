/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {Mutex} from 'async-mutex';
import {exec as unsafeExec, Output} from 'promisify-child-process';
import {reportPlatformFailures} from 'flipper-common';
import {promises, constants} from 'fs';
import memoize from 'lodash.memoize';
import {notNull} from '../../utils/typeUtils';
import {promisify} from 'util';
import child_process from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import {recorder} from '../../recorder';
const exec = promisify(child_process.exec);

export type IdbConfig = {
  idbPath: string;
  enablePhysicalIOS: boolean;
};

// Use debug to get helpful logs when idb fails
const IDB_LOG_LEVEL = 'DEBUG';
const LOG_TAG = 'iOSContainerUtility';

const mutex = new Mutex();

type IdbTarget = {
  name: string;
  udid: string;
  state: 'Booted' | 'Shutdown';
  type: string | DeviceType;
  target_type?: string | DeviceType;
  os_version: string;
  architecture: string;
};

export type DeviceType = 'physical' | 'emulator';

export type DeviceTarget = {
  udid: string;
  type: DeviceType;
  name: string;
};

async function isAvailable(idbPath: string): Promise<boolean> {
  if (!idbPath) {
    return false;
  }
  try {
    await promises.access(idbPath, constants.X_OK);
  } catch (e) {
    return false;
  }
  return true;
}

async function safeExec(
  command: string,
): Promise<{stdout: string; stderr: string} | Output> {
  const release = await mutex.acquire();
  return await unsafeExec(command).finally(release);
}

async function queryTargetsWithXcode(
  context: any,
): Promise<Array<DeviceTarget>> {
  const cmd = 'xcrun xctrace list devices';
  const description = 'Query available devices with Xcode';
  const troubleshoot = `Xcode command line tools are not installed.
    Run 'xcode-select --install' from terminal.`;

  try {
    const {stdout} = await safeExec(cmd);
    if (!stdout) {
      recorder.event('cmd', {
        cmd,
        description,
        success: false,
        troubleshoot,
        context,
      });
      throw new Error('No output from command');
    }
    recorder.event('cmd', {
      cmd,
      description,
      success: true,
      context,
    });
    return stdout
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => /(.+) \([^(]+\) \[(.*)\]( \(Simulator\))?/.exec(line))
      .filter(notNull)
      .filter(([_match, _name, _udid, isSim]) => !isSim)
      .map<DeviceTarget>(([_match, name, udid]) => {
        return {udid, type: 'physical', name};
      });
  } catch (e) {
    recorder.event('cmd', {
      cmd,
      description,
      success: false,
      troubleshoot,
      stderr: e.toString(),
      context,
    });
    return [];
  }
}

async function queryTargetsWithIdb(
  idbPath: string,
  context: any,
): Promise<Array<DeviceTarget>> {
  const cmd = `${idbPath} list-targets --json`;
  const description = `Query available devices with idb. idb is aware of the companions that you have
    manually connected, as well as other iOS targets that do not yet have companions.`;
  const troubleshoot = `Either idb is not installed or needs to be reset.
    Run 'idb kill' from terminal.`;

  try {
    const {stdout} = await safeExec(cmd);
    if (!stdout) {
      recorder.event('cmd', {
        cmd,
        description,
        success: false,
        troubleshoot,
        context,
      });
      throw new Error('No output from command');
    }

    recorder.event('cmd', {
      cmd,
      description,
      success: true,
      context,
    });

    return parseIdbTargets(stdout.toString());
  } catch (e) {
    recorder.event('cmd', {
      cmd,
      description,
      success: false,
      troubleshoot,
      stderr: e.toString(),
      context,
    });
    return [];
  }
}

async function queryTargetsWithIdbCompanion(
  idbCompanionPath: string,
  isPhysicalDeviceEnabled: boolean,
  context: any,
): Promise<Array<DeviceTarget>> {
  const cmd = `${idbCompanionPath} --list 1 --only device`;
  const description = `Query available devices with idb companion. Lists all available devices and simulators
    in the current context. If Xcode is not correctly installed, only devices will be listed.`;
  const troubleshoot = `Unable to locate idb_companion in '${idbCompanionPath}'.
    Try running sudo yum install -y fb-idb`;

  if (await isAvailable(idbCompanionPath)) {
    try {
      const {stdout} = await safeExec(cmd);
      if (!stdout) {
        recorder.event('cmd', {
          cmd,
          description,
          success: false,
          troubleshoot,
          context,
        });
        throw new Error('No output from command');
      }

      recorder.event('cmd', {
        cmd,
        description,
        success: true,
        context,
      });

      const devices = parseIdbTargets(stdout.toString());
      if (devices.length > 0 && !isPhysicalDeviceEnabled) {
        recorder.rawError(
          `You are trying to connect Physical Device.
          Please enable the toggle "Enable physical iOS device" from the setting screen.`,
        );
      }
      return devices;
    } catch (e) {
      recorder.event('cmd', {
        cmd,
        description,
        success: false,
        troubleshoot,
        stderr: e.toString(),
        context,
      });
      return [];
    }
  } else {
    recorder.event('cmd', {
      cmd,
      description,
      success: false,
      troubleshoot,
      context,
    });
    return [];
  }
}

function parseIdbTarget(line: string): DeviceTarget | undefined {
  const parsed: IdbTarget = JSON.parse(line);
  if (parsed.state.toLocaleLowerCase() !== 'booted') {
    return;
  }
  return {
    udid: parsed.udid,
    type:
      (parsed.type || parsed.target_type) === 'simulator'
        ? 'emulator'
        : ('physical' as DeviceType),
    name: parsed.name,
  };
}

function parseIdbTargets(lines: string): Array<DeviceTarget> {
  const parsedIdbTargets = lines
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseIdbTarget(line))
    .filter((target): target is DeviceTarget => !!target);

  const dedupedIdbTargets: Record<string, DeviceTarget> = {};
  for (const idbTarget of parsedIdbTargets) {
    dedupedIdbTargets[idbTarget.udid] =
      dedupedIdbTargets[idbTarget.udid] ?? idbTarget;
  }
  return Object.values(dedupedIdbTargets);
}

async function idbDescribeTarget(
  idbPath: string,
  context: any,
): Promise<DeviceTarget | undefined> {
  const cmd = `${idbPath} describe --json`;
  const description = `Returns metadata about the specified target, including:
    UDID,
    Name,
    Screen dimensions and density,
    State (booted/...),
    Type (simulator/device),
    iOS version,
    Architecture,
    Information about its companion,
  `;
  const troubleshoot = `Either idb is not installed or needs to be reset.
    Run 'idb kill' from terminal.`;

  try {
    const {stdout} = await safeExec(cmd);
    if (!stdout) {
      recorder.event('cmd', {
        cmd,
        description,
        success: false,
        troubleshoot,
        context,
      });
      throw new Error('No output from command');
    }

    recorder.event('cmd', {
      cmd,
      description,
      success: true,
      stdout: stdout.toString(),
      context,
    });

    return parseIdbTarget(stdout.toString());
  } catch (e) {
    recorder.event('cmd', {
      cmd,
      description,
      success: false,
      troubleshoot,
      stderr: e.toString(),
      context,
    });
    return undefined;
  }
}

async function targets(
  idbPath: string,
  isPhysicalDeviceEnabled: boolean,
  context?: any,
): Promise<Array<DeviceTarget>> {
  if (process.platform !== 'darwin') {
    return [];
  }

  // If companion is started by some external process and its path
  // is provided to Flipper via IDB_COMPANION environment variable,
  // use that instead and do not query other devices.
  // See stack of D36315576 for details
  if (process.env.IDB_COMPANION) {
    const target = await idbDescribeTarget(idbPath, context);
    return target ? [target] : [];
  }

  const isXcodeInstalled = await isXcodeDetected();
  if (!isXcodeInstalled) {
    if (!isPhysicalDeviceEnabled) {
      recorder.rawError(
        'You are trying to connect a physical device. Please enable the toggle "Enable physical iOS device" from the setting screen.',
      );
    }
    const idbCompanionPath = path.dirname(idbPath) + '/idb_companion';
    return queryTargetsWithIdbCompanion(
      idbCompanionPath,
      isPhysicalDeviceEnabled,
      context,
    );
  }

  // Not all users have idb installed because you can still use
  // Flipper with Simulators without it.
  // But idb is MUCH more CPU efficient than xcrun, so
  // when installed, use it. This still holds true
  // with the move from instruments to xcrun.
  if (await memoize(isAvailable)(idbPath)) {
    return await queryTargetsWithIdb(idbPath, context);
  } else {
    return queryTargetsWithXcode(context);
  }
}

async function push(
  udid: string,
  src: string,
  bundleId: string,
  dst: string,
  idbPath: string,
  context?: any,
): Promise<void> {
  await memoize(checkIdbIsInstalled)(idbPath);

  const push_ = async () => {
    const cmd = `${idbPath} file push --log ${IDB_LOG_LEVEL} --udid ${udid} --bundle-id ${bundleId} '${src}' '${dst}'`;
    const description = `idb push file to device`;
    const troubleshoot = `Either idb is not installed or needs to be reset.
    Run 'idb kill' from terminal.`;

    try {
      await safeExec(cmd);
      recorder.event('cmd', {
        cmd,
        description,
        success: true,
        troubleshoot,
        context,
      });
    } catch (e) {
      recorder.event('cmd', {
        cmd,
        description,
        success: false,
        stdout: e.toString(),
        troubleshoot,
        context,
      });
      handleMissingIdb(e, idbPath);
      throw e;
    }
  };

  return reportPlatformFailures(push_(), `${LOG_TAG}:push`);
}

async function pull(
  udid: string,
  src: string,
  bundleId: string,
  dst: string,
  idbPath: string,
  context?: any,
): Promise<void> {
  await memoize(checkIdbIsInstalled)(idbPath);

  const pull_ = async () => {
    const cmd = `${idbPath} file pull --log ${IDB_LOG_LEVEL} --udid ${udid} --bundle-id ${bundleId} '${src}' '${dst}'`;
    const description = `idb pull file from device`;
    const troubleshoot = `Either idb is not installed or needs to be reset.
    Run 'idb kill' from terminal.`;

    try {
      await safeExec(cmd);
      recorder.event('cmd', {
        cmd,
        description,
        success: true,
        troubleshoot,
        context,
      });
    } catch (e) {
      recorder.event('cmd', {
        cmd,
        description,
        success: false,
        stdout: e.toString(),
        troubleshoot,
        context,
      });
      handleMissingIdb(e, idbPath);
      handleMissingPermissions(e);
      throw e;
    }
  };

  return reportPlatformFailures(pull_(), `${LOG_TAG}:pull`);
}

async function checkIdbIsInstalled(idbPath: string): Promise<void> {
  const isInstalled = await isAvailable(idbPath);
  if (!isInstalled) {
    throw new Error(
      `idb is required to use iOS devices. Install it with instructions
      from https://github.com/facebook/idb and set the installation path in Flipper settings.`,
    );
  }
}

// The fb-internal idb binary is a shim that downloads the proper one on first run.
// It requires sudo to do so. If we detect this, tell the user how to fix it.
function handleMissingIdb(e: Error, idbPath: string): void {
  if (
    e.message &&
    e.message.includes('sudo: no tty present and no askpass program specified')
  ) {
    console.warn(e);
    throw new Error(
      `idb doesn't appear to be installed. Run "${idbPath} list-targets" to fix this.`,
    );
  }
}

function handleMissingPermissions(e: Error): void {
  if (
    e.message &&
    e.message.includes('Command failed') &&
    e.message.includes('file pull') &&
    e.message.includes('sonar/app.csr')
  ) {
    console.warn(e);
    throw new Error(
      'Cannot connect to iOS application. idb_certificate_pull_failed' +
        'idb lacks permissions to exchange certificates. Did you install a source build ([FB] or enable certificate exchange)? See console logs for more details.',
    );
  }
}

async function isXcodeDetected(): Promise<boolean> {
  try {
    const {stdout} = await exec('xcode-select -p');
    return fs.pathExists(stdout.trim());
  } catch (e) {
    return false;
  }
}

export default {
  targets,
  push,
  pull,
  isXcodeDetected,
};
