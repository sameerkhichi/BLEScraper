const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const SCHEDULER = path.join(
  'node_modules',
  'expo-background-task',
  'ios',
  'BackgroundTaskScheduler.swift',
);
const DELEGATE = path.join(
  'node_modules',
  'expo-background-task',
  'ios',
  'BackgroundTaskAppDelegate.swift',
);

const WAKE_MARKER = '// BLESCRAPER_BACKGROUND_WAKE';
const RESUBMIT_MARKER = '// BLESCRAPER_BACKGROUND_RESUBMIT';

function replaceOnce(source, from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`Background wake patch could not find ${label}.`);
  }
  return source.replace(from, to);
}

function patchScheduler(source) {
  if (source.includes(WAKE_MARKER)) return source;
  let next = replaceOnce(
    source,
    `    func didRegisterTask(minutes: Int?) -> Bool {
      if let minutes = minutes {
        intervalSeconds = Double(minutes) * 60
      }
      numberOfRegisteredTasksOfThisType += 1

      return numberOfRegisteredTasksOfThisType == 1
    }`,
    `    func didRegisterTask(minutes: Int?) -> Bool {
      if let minutes = minutes {
        intervalSeconds = Double(minutes) * 60
        UserDefaults.standard.set(minutes, forKey: "blescraper.backgroundTaskMinutes")
      }
      numberOfRegisteredTasksOfThisType += 1
      UserDefaults.standard.set(true, forKey: "blescraper.backgroundTaskRegistered")

      return numberOfRegisteredTasksOfThisType == 1
    }`,
    'didRegisterTask',
  );
  next = replaceOnce(
    next,
    `    func didUnregisterTask() -> Bool {
      numberOfRegisteredTasksOfThisType = max(0, numberOfRegisteredTasksOfThisType - 1)
      return numberOfRegisteredTasksOfThisType == 0
    }`,
    `    func didUnregisterTask() -> Bool {
      numberOfRegisteredTasksOfThisType = max(0, numberOfRegisteredTasksOfThisType - 1)
      if numberOfRegisteredTasksOfThisType == 0 {
        UserDefaults.standard.set(false, forKey: "blescraper.backgroundTaskRegistered")
      }
      return numberOfRegisteredTasksOfThisType == 0
    }`,
    'didUnregisterTask',
  );
  next = replaceOnce(
    next,
    `    func hasRegisteredTasks() -> Bool {
      return numberOfRegisteredTasksOfThisType > 0
    }`,
    `    func hasRegisteredTasks() -> Bool {
      return numberOfRegisteredTasksOfThisType > 0
        || UserDefaults.standard.bool(forKey: "blescraper.backgroundTaskRegistered")
    }`,
    'hasRegisteredTasks',
  );
  next = replaceOnce(
    next,
    `    func scheduleWorker() throws {
      if numberOfRegisteredTasksOfThisType == 0 {
        print("Background Task: skipping scheduling. No registered tasks")
        return
      }`,
    `    func scheduleWorker() throws {
      ${WAKE_MARKER}
      let remembered = UserDefaults.standard.bool(forKey: "blescraper.backgroundTaskRegistered")
      if numberOfRegisteredTasksOfThisType == 0 && !remembered {
        print("Background Task: skipping scheduling. No registered tasks")
        return
      }
      if numberOfRegisteredTasksOfThisType == 0 {
        let minutes = UserDefaults.standard.integer(forKey: "blescraper.backgroundTaskMinutes")
        if minutes > 0 {
          intervalSeconds = Double(minutes) * 60
        }
      }`,
    'scheduleWorker',
  );
  return replaceOnce(
    next,
    'request.requiresNetworkConnectivity = true',
    'request.requiresNetworkConnectivity = false',
    'requiresNetworkConnectivity',
  );
}

function patchDelegate(source) {
  if (source.includes(RESUBMIT_MARKER)) return source;
  return replaceOnce(
    source,
    '  private func reschedule() {',
    `  ${RESUBMIT_MARKER}
  public func applicationDidEnterBackground(_ application: UIApplication) {
    Task {
      if await BackgroundTaskScheduler.isWorkerRunning() { return }
      do {
        try await BackgroundTaskScheduler.tryScheduleWorker()
      } catch {
        log.error("Could not schedule the background download: \\(error.localizedDescription)")
      }
    }
  }

  private func reschedule() {`,
    'applicationDidEnterBackground',
  );
}

function withBackgroundWake(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const root = config.modRequest.projectRoot;
      const schedulerFile = path.join(root, SCHEDULER);
      const delegateFile = path.join(root, DELEGATE);
      const scheduler = patchScheduler(fs.readFileSync(schedulerFile, 'utf8'));
      const delegate = patchDelegate(fs.readFileSync(delegateFile, 'utf8'));
      fs.writeFileSync(schedulerFile, scheduler);
      fs.writeFileSync(delegateFile, delegate);
      return config;
    },
  ]);
}

module.exports = withBackgroundWake;
module.exports.patchScheduler = patchScheduler;
module.exports.patchDelegate = patchDelegate;
