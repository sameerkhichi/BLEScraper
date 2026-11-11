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
const REFRESH_SCHEDULE_MARKER = '// BLESCRAPER_REFRESH_SCHEDULE';
const REFRESH_TASK_MARKER = '// BLESCRAPER_REFRESH_TASK';

function replaceOnce(source, from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`Background wake patch could not find ${label}.`);
  }
  return source.replace(from, to);
}

function patchScheduler(source) {
  let next = source;
  if (!next.includes(WAKE_MARKER)) {
    next = replaceOnce(
      next,
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
    next = replaceOnce(
      next,
      'request.requiresNetworkConnectivity = true',
      'request.requiresNetworkConnectivity = false',
      'requiresNetworkConnectivity',
    );
  }
  if (next.includes(REFRESH_SCHEDULE_MARKER)) return next;
  next = replaceOnce(
    next,
    `  public static func didRegisterTask(minutes: Int?) {
    Task {
      if await schedulerState.didRegisterTask(minutes: minutes) {
        try await tryScheduleWorker()
      }
    }
  }`,
    `  public static func didRegisterTask(minutes: Int?) {
    Task {
      ${REFRESH_SCHEDULE_MARKER}
      if await schedulerState.didRegisterTask(minutes: minutes) {
        try await tryScheduleWorker()
      }
      await RefreshWake.scheduleIfIdle()
    }
  }`,
    'public didRegisterTask',
  );
  return replaceOnce(
    next,
    `  public static func didUnregisterTask() {
    Task {
      if await schedulerState.didUnregisterTask() {
        await stopWorker()
      }
    }
  }`,
    `  public static func didUnregisterTask() {
    Task {
      if await schedulerState.didUnregisterTask() {
        await stopWorker()
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: RefreshWake.identifier)
      }
    }
  }`,
    'public didUnregisterTask',
  );
}

function patchDelegate(source) {
  if (source.includes(REFRESH_TASK_MARKER)) return source;
  let next = source;
  if (!next.includes('enum RefreshWake')) {
    next = replaceOnce(
      next,
      'public class BackgroundTaskAppDelegateSubscriber: ExpoAppDelegateSubscriber {',
      `enum RefreshWake {
  static let identifier = "com.sameer.blescraper.refresh"
  static let floorSeconds: TimeInterval = 15 * 60

  static func submitNext() {
    let request = BGAppRefreshTaskRequest(identifier: identifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: floorSeconds)
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      log.error("Could not submit the background refresh: \\(error.localizedDescription)")
    }
  }

  static func scheduleIfIdle() async {
    guard UserDefaults.standard.bool(forKey: "blescraper.backgroundTaskRegistered") else { return }
    let pending = await BGTaskScheduler.shared.pendingTaskRequests()
    if pending.contains(where: { $0.identifier == identifier }) { return }
    submitNext()
  }
}

public class BackgroundTaskAppDelegateSubscriber: ExpoAppDelegateSubscriber {`,
      'RefreshWake',
    );
  }
  return replaceOnce(
    next,
    `  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    if BackgroundTaskScheduler.supportsBackgroundTasks() {
      BGTaskScheduler.shared.register(forTaskWithIdentifier: BackgroundTaskConstants.BackgroundWorkerIdentifier, using: nil) { task in
        log.debug("Expo Background Tasks - starting background work")

        // Set up expiration handler
        task.expirationHandler = { ()
          log.warn("Expo Background Tasks - task expired")
          // Send message to Expo module
          NotificationCenter.default.post(name: onTasksExpiredNotification, object: self, userInfo: [:])
          task.setTaskCompleted(success: false)
          self.reschedule()
        }

        // Let's find the task service implementation and call the runTasks(withReason)
        if let taskService = EXTaskServiceHelper.sharedTaskService() {
          taskService.runTasks(with: EXTaskLaunchReasonBackgroundTask, userInfo: nil, completionHandler: { _ in
            // Mark iOS task as finished - this is important so that we can continue calling it
            task.setTaskCompleted(success: true)
            self.reschedule()
          })
        } else {
          task.setTaskCompleted(success: false)
          log.error("Expo Background Tasks: Could not find TaskService module")
        }
      }

      // Signal to the scheduler that we're done.
      BackgroundTaskScheduler.bgTaskSchedulerDidFinishRegister()
    }

    return true
  }`,
    `  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    if BackgroundTaskScheduler.supportsBackgroundTasks() {
      BGTaskScheduler.shared.register(forTaskWithIdentifier: BackgroundTaskConstants.BackgroundWorkerIdentifier, using: nil) { task in
        log.debug("Expo Background Tasks - starting background work")
        self.runBackgroundWork(task, historyDays: 7, rescheduleProcessing: true)
      }

      ${REFRESH_TASK_MARKER}
      BGTaskScheduler.shared.register(forTaskWithIdentifier: RefreshWake.identifier, using: nil) { task in
        log.debug("BLEScraper refresh started")
        RefreshWake.submitNext()
        self.runBackgroundWork(task, historyDays: 2, rescheduleProcessing: false)
      }

      BackgroundTaskScheduler.bgTaskSchedulerDidFinishRegister()
      Task {
        await RefreshWake.scheduleIfIdle()
      }
    }

    return true
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    Task {
      await RefreshWake.scheduleIfIdle()
      if await BackgroundTaskScheduler.isWorkerRunning() { return }
      do {
        try await BackgroundTaskScheduler.tryScheduleWorker()
      } catch {
        log.error("Could not schedule the background download: \\(error.localizedDescription)")
      }
    }
  }

  private func runBackgroundWork(_ task: BGTask, historyDays: Int, rescheduleProcessing: Bool) {
    var finished = false
    let finish: (Bool) -> Void = { success in
      if finished { return }
      finished = true
      task.setTaskCompleted(success: success)
    }
    task.expirationHandler = {
      log.warn("Background task expired")
      NotificationCenter.default.post(name: onTasksExpiredNotification, object: self, userInfo: [:])
      finish(false)
      if rescheduleProcessing { self.reschedule() }
    }
    if let taskService = EXTaskServiceHelper.sharedTaskService() {
      taskService.runTasks(with: EXTaskLaunchReasonBackgroundTask, userInfo: ["historyDays": historyDays], completionHandler: { _ in
        finish(true)
        if rescheduleProcessing { self.reschedule() }
      })
    } else {
      finish(false)
      log.error("Could not find TaskService module")
    }
  }`,
    'didFinishLaunching',
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
