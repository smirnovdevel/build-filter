import { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';
import { SIGINT } from 'constants';
import * as vscode from 'vscode';
import { getCommandFromPubspec, getDartProjectPath } from './extension';
import { ChildProcessWrapper } from './process';
import { SigintSender } from './sigint';
import { command, COMMANDS, DartFlutterCommand, deleteConflictingOutputsSuffix, isWin32, log, output, pubCommand, settings } from "./utils";

enum State { initializing, watching, idle, }

const timeout = <T>(prom: Promise<T>, time: number) =>
  Promise.race<T>([prom, new Promise<T>((_r, rej) => setTimeout(rej, time))]);

interface ExitData extends Object {
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

const exitDataToString = (d: ExitData) => `{code: ${d.code}, signal: ${d.signal}}`;

const cp = new ChildProcessWrapper(true);

export class BuildRunnerWatch {

  readonly sigintSender: SigintSender;

  constructor(context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.statusBar.command = COMMANDS.watch;
    this.statusBar.tooltip = "Watch with build_runner";
    this.statusBar.text = this.text();
    context.subscriptions.push(this.statusBar);

    this.sigintSender = new SigintSender(
      context,
      "https://github.com/gaetschwartz/SigintSender/releases/download/ci-deploy-8/SigintSender-x64-8.exe"
    );
  }

  state: State = State.idle;
  process: ChildProcessWithoutNullStreams | undefined;
  command: DartFlutterCommand | undefined;

  readonly watchString = "$(eye) Watch";
  readonly loadingString = "$(loading~spin) Initializing";
  readonly removeWatchString = "$(eye-closed) Remove watch";

  readonly statusBar: vscode.StatusBarItem;

  show(): void {
    this.statusBar.show();
  }

  text(): string {
    switch (this.state) {
      case State.idle:
        return this.watchString;
      case State.watching:
        return this.removeWatchString;
      case State.initializing:
        return this.loadingString;
    }
  }

  setState(state: State): void {
    this.state = state;
    this.statusBar.text = this.text();
  }

  async toggle(): Promise<void> {
    switch (this.state) {
      case State.idle:
        output.show();
        return this.watch();
      case State.watching:
        output.show();
        return this.removeWatch();
      case State.initializing:
        break;
    }
  }

  async removeWatch(): Promise<void> {
    if (process !== undefined) {

      try {
        const exit = await timeout<ExitData>(new Promise(async (cb) => {
          this.process?.on('exit', (code, sgn) => cb({ signal: sgn, code: code }));
          // Try to submit 'y' to answer the dialog 'Terminate batch job (Y/N)? '.
          this.process?.stdin.write('y\n');
          await this.killWatch();
        }), 2500);

        console.log(`Exited successfully with: ${exitDataToString(exit)}`);

        if (exit.code === 0) {
          console.log('Success, cleaning...');
          this.process = undefined;
          output.appendLine("Stopped watching");
          this.setState(State.idle);
        }
      } catch (error) {
        vscode.window.showErrorMessage("Failed to remove the watch! Try again. If it still doesn't work try closing VSCode and reopening.", "Okay");
      }
    }
  }



  async killWatch(): Promise<void> {
    if (this.process !== undefined) {
      console.log('Going to try to kill the watch...');
      console.log('PID of parent is ' + this.process.pid);
      let pid: string | undefined = cp.getChildPID(this.process?.pid?.toString());
      // when using flutter, the pid tree is like this:
      //  \-+- ${process.pid}  bash <flutter_path>/bin/flutter pub run build_runner watch
      //   \-+- child_pid1      <flutter_path>/bin/cache/dart-sdk/bin/dart --disable-dart-dev --packages=<flutter_path>/packages/flutter_tools/.packages <flutter_path>/bin/cache/flutter_tools.snapshot pub run build_runner watch
      //    \--- child_pid2      <flutter_path>/bin/cache/dart-sdk/bin/dart __deprecated_pub run build_runner watch
      // we thus need to kill child_pid2 by finding process.pid's grandchild
      if (this.command === "flutter") {
        const newPid = cp.getChildPID(pid);
        if (newPid !== undefined) {
          pid = newPid;
        }
      }

      console.log('PID of actual process is ' + pid);
      if (pid !== undefined) {
        cp.killPid(pid);
      }
    }
    this.process?.kill(SIGINT);
  }


  async queryProject(): Promise<vscode.Uri | undefined> {
    const choose = "Choose a folder";
    const res = await vscode.window.showInformationMessage("Failed to determine where to run the command. Please choose where to run it.", choose);
    if (res !== choose) { return undefined; }
    const uri = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
    if (uri === undefined) { return undefined; }
    return uri[0];
  }


  async watch(): Promise<void> {
    output.clear();

    if (isWin32) {
      const risk = "I take the risk.";
      const res = await vscode.window.showWarningMessage("Using `build_runner watch` on Windows is still in BETA. There might be issues with stopping the watch which might cause further issues.", risk);
      if (res !== risk) { return; }
    }

    let cwd = getDartProjectPath();

    if (cwd === undefined) {
      const uri = await this.queryProject();
      if (uri === undefined) {
        return;
      } else {
        cwd = uri.fsPath;
      }
    }
    console.log(`cwd=${cwd}`);

    this.command = getCommandFromPubspec(cwd) || settings.commandToUse;

    const cmd = command(this.command);
    const args: string[] = [...pubCommand(this.command), "build_runner", "watch"];
    const opts: SpawnOptionsWithoutStdio = { cwd: cwd };
    if (settings.useDeleteConflictingOutputs.watch) { args.push(deleteConflictingOutputsSuffix); }

    log(`Spawning \`${cmd} ${args.join(' ')}\` in \`${opts.cwd}\``);

    this.process = cp.spawn(cmd, args, opts);
    this.setState(State.initializing);

    console.log(`Started with PID: ${this.process!.pid}`);

    this.process.stdout.on('data', (data) => {
      const string = data.toString();
      console.log('stdout: ' + string);
      if (this.state !== State.watching) { this.setState(State.watching); }
      output.append(string);
    });

    this.process.stderr.on('data', (data) => {
      const err = data.toString();
      console.log('stderr: ' + err);
      output.append(err);
    });

    this.process.stdin.on('data', (data) => {
      const stdin = data.toString();
      console.log('stdin: ' + stdin);
    });

    this.process.on('error', (err) => { console.error(err); });
    this.process.on('message', (err) => { console.info('info:', err); });

    this.process.on('close', (code) => {
      console.log("close: " + code);

      if (code !== null && code !== 0) {
        output.appendLine("\nCommand exited with code " + code);
        output.show();
      }

      this.process = undefined;
      this.setState(State.idle);
    });
  }
}


