import { INotebook } from "model";
import { ICell } from "model";
import { BasicEventHandler } from "utils";
import { convertDisplayValue } from "./convert-value";
import { CodeGenerator } from "./code-generator";
import { ILog } from "utils";
import { assert } from "chai";
import * as vm from 'vm';
import { formatErrorMessage, ErrorSource } from "./format-error-message";
import { ISourceMap } from "./source-map";
import { IFileLocation, IGeneratedCode } from "./language-code-generator";
import { ProjectGenerator } from "./project-generator";
import { CellType } from "model";
import { NullAsyncTracker, IAsyncTracker, AsyncTracker } from "./async-tracker";
import { AsyncResource, executionAsyncId } from "async_hooks";
import { handleAsyncErrors } from "utils";
import * as fs from "fs";
import { ISerializedCellOutput1 } from "model";
import { EventEmitter } from "events";
import { INpm } from "./npm";
import { performance } from "perf_hooks";

//
// Maximum number of outputs before outputs are capped.
//
const MAX_OUTPUTS = 1000;

//
// Save the original require, can't access it from within a DFN script.
//
const originalRequire = require;
const resolve = require('resolve-cwd');

//
// Event raised relating to a particular cell.
//
export type CellEventHandler = (cellId: string) => void;

//
// Event raised when a particular cell displays some output.
//
export type DisplayEventHandler = (cellId: string, outputs: ISerializedCellOutput1[]) => void;

//
// Event raised when a particular cell has an error.
//
export type ErrorEventHandler = (cellId: string, error: string) => void;

//
// Evaluates code for Data-Forge Notebook.
//

export interface ICodeEvaluator {

    //
    // Event raised when evaluation of a particular cell has started.
    //
    onCellEvalStarted?: CellEventHandler;
    
    //
    // Event raised when evaluation of a particular cell has ended.
    //
    onCellEvalEnded?: CellEventHandler;

    //
    // Event raised when evaluation has completed.
    //
    onEvaluationCompleted?: () => void;

    //
    // Event raised when a cell's output has been capped.
    //
    onOutputCapped?: BasicEventHandler;

    //
    // Event raised when a cells displays some ouptut.
    //
    onDisplay?: DisplayEventHandler;

    //
    // Event raised when a cells displays some ouptut.
    //
    onError?: ErrorEventHandler;

    //
    // Evaluate code for a notebook.
    //
    evalCode(): void;
}

export class CodeEvaluator implements ICodeEvaluator {

    //
    // Event raised when evaluation of a particular cell has started.
    //
    onCellEvalStarted?: CellEventHandler;
    
    //
    // Event raised when evaluation of a particular cell has ended.
    //
    onCellEvalEnded?: CellEventHandler;

    //
    // Event raised when evaluation has completed.
    //
    onEvaluationCompleted?: () => void;

    //
    // Event raised when a cell's output has been capped.
    //
    onOutputCapped?: BasicEventHandler;

    //
    // Event raised when a cells displays some ouptut.
    //
    onDisplay?: DisplayEventHandler;

    //
    // Event raised when a cells displays some ouptut.
    //
    onError?: ErrorEventHandler;

    //
    // Logging conduit.
    //
    private log: ILog;

    //
    // For interaction with npm.
    //
    private npm: INpm;

   
    //
    // The number of cells to be evaluated.
    //
    private numCells: number;

    //
    // Number of outputs received for the current cell.
    //
    private numOutputs = 0;

    //
    // Set to true when output has been capped.
    //
    private outputsCapped = false;

    //
    // Set to true after the last cell has executed, doesn't including indirect async operations.
    //
    private notebookCompleted = false; 

    //
    // set true when notebook has completed evaluation (set either from an error or from notebook completion plus completion of indirect async coperations).
    //
    private notebookFinished = false; 
    
    //
    // Tracks async operations for the notebook.
    //
    private readonly asyncTracker: IAsyncTracker = new AsyncTracker();

    //
    // Used to save and restore std output and error.
    //
    private oldStdoutWrite: any;
    private oldStderrWrite: any;
    
    //
    // The notebook to be evaluated.
    //
    private notebook: INotebook;
    
    //
    // Cells in the notebook to be evaluated.
    //
    private cells: ICell[];

    //
    // Ids of the cells.
    //
    private cellIds: string[];

    //
    // Record the cells that have completed all async operations.
    //
    private cellsCompleted: boolean[];

    //
    // Caches the functions that retrieve local variable values.
    //
    private localsFnCache: any[];

    //
    // The file name of the notebook.
    //
    private fileName: string;

    //
    // The path to the notebook project.
    //
    private projectPath: string;

    //
    // Code that was generated for this notebook.
    //
    private code?: string;

    //
    // Source map for generated code.
    //
    private sourceMap?: ISourceMap;

    //
    // Puts maximum time on syncrhonous code execution before the process is terminated.
    //
    private timeout: number | undefined;
    
    //
    // Records the time that evaluation took.
    //
    private startTime: number | undefined = undefined;

    //
    // The passed in process object so global access can be controlled separately.
    //
    private process: NodeJS.Process;

    constructor(process: NodeJS.Process, notebook: INotebook, allCells: ICell[], fileName: string, projectPath: string, npm: INpm, log: ILog, timeout: number | undefined) {
        this.process = process;
        this.timeout = timeout;
        this.npm = npm;
        this.log = log;
        this.notebook = notebook;
        this.cells = allCells.filter(cell => cell.getCellType() === CellType.Code);
        if (this.cells.length === 0) {
            throw new Error("Need some code cells!");
        }
        this.cellIds = this.cells.map(cell => cell.getId());

        const numCells = this.cells.length;
        this.cellsCompleted = new Array(numCells);
        for (let cellIndex = 0; cellIndex < numCells; ++cellIndex) {
            this.cellsCompleted[cellIndex] = false;
        }

        //
        // Caches the functions that retrieve local variable values.
        //
        this.localsFnCache = new Array(numCells);

        this.fileName = fileName;
        this.projectPath = projectPath;
        this.numCells = numCells;

        this.display = this.display.bind(this);
        this.onUncaughtException = this.onUncaughtException.bind(this);
        this.onUnhandledRejection = this.onUnhandledRejection.bind(this);
        this.awaitNotebookCompleted = this.awaitNotebookCompleted.bind(this);
        this.__capture_locals = this.__capture_locals.bind(this);
        this.__auto_display = this.__auto_display.bind(this);        
        this.__cell = this.__cell.bind(this);
        this.__end = this.__end.bind(this);
    }

    // 
    // Returns true if output is now capped.
    //
    private isOutputCapped(): boolean {
        if (this.outputsCapped) {
            // Already capped.
            return true;
        }

        if (this.numOutputs >= MAX_OUTPUTS) {
            if (!this.outputsCapped) {
                if (this.onOutputCapped) {
                    this.onOutputCapped(); // Let the user interface know that outputs have been capped.
                }
                this.outputsCapped = true;
            }
            return true;
        }

        ++this.numOutputs;
        return false;
    }

    //
    // Get the parent cell ID for a particular async operation.
    //
    private getParentCellIndex(asyncId: number): number | undefined {
        return this.asyncTracker.findCellIndex(asyncId);
    }

    //
    // Get the ID of the currently executing code cell, otherwise get the first cell's id.
    //
    private getCurCellId(): string {
        const asyncId = executionAsyncId()
        const cellIndex = this.getParentCellIndex(asyncId) || 0;
        return this.cellIds[cellIndex];
    }

    private display(...args: any[]): void {

        // this.log.info(`Displaying ${args.join(',')} in async context ${executionAsyncId()} for cell ${this.getCurCellId()}.`);

        if (!this.isOutputCapped()) {
            if (this.onDisplay) {
                const converted = args.map(arg => ({ value: convertDisplayValue(arg) }));
                this.onDisplay(this.getCurCellId(), converted);
            }
        }
    };

    private displayType(displayType: string, args: any[], converter?: (args: any[]) => any[]): void {
        if (!this.isOutputCapped()) {
            if (this.onDisplay) {
                if (converter) {
                    args = converter(args);
                }
                const converted = args.map(arg => ({
                    value: {
                        displayType,
                        data: arg,
                    },
                }));
                this.onDisplay(this.getCurCellId(), converted);
            }
        }
    }

    private displayTable(...args: any[]): void {
        if (!this.isOutputCapped()) {
            if (this.onDisplay) {
                const converted = args.map(arg => ({ 
                    value: convertDisplayValue(arg, "table"),
                }));
                this.onDisplay(this.getCurCellId(), converted);
            }
        }
    }

    //
    // Captures standard output while evaluating a notebook.
    //
    private stdoutWriteOverride(...args: any[]): boolean {

        // this.log.info(`Stdout ${args[0]} in async context ${executionAsyncId()} for cell ${this.getCurCellId()}.`);

        if (!this.isOutputCapped()) {
            if (this.onDisplay) {
                const converted = {
                    value: convertDisplayValue(args[0].toString()),
                };
                this.onDisplay(this.getCurCellId(), [ converted ]);
            }

            return this.oldStdoutWrite.apply(this.process.stdout, args);
        }
        else {
            return true;
        }
    };
    
    //
    // Captures standard error while evaluating a notebook.
    //
    private stderrWriteOverride(...args: any[]): boolean {

        // this.log.info(`Stderr ${args[0]} in async context ${executionAsyncId()} for cell ${this.getCurCellId()}.`);

        if (!this.isOutputCapped()) {
            if (this.onError) {
                this.onError(this.getCurCellId(), args[0]);
            }

            return this.oldStderrWrite.apply(this.process.stderr, args);
        }
        else {
            return true;
        }
    };

    //
    // Override std output and error to capture it while evaluating a notebook.
    //
    private overrideOutput(): void {
        this.oldStdoutWrite = this.process.stdout.write;
        this.oldStderrWrite = this.process.stderr.write;

        this.process.stdout.write = this.stdoutWriteOverride.bind(this);
        this.process.stderr.write = this.stderrWriteOverride.bind(this);
    }

    //
    // Restore output to normal state.
    //
    private restoreOutput() {
        this.process.stdout.write = this.oldStdoutWrite;
        this.process.stderr.write = this.oldStderrWrite;
    }

    //
    // Map module require statements to the notebook's directory.
    //
    private proxyRequire(moduleName: string): any {
        const resolvedModuleName = resolve(moduleName);
        if (!resolvedModuleName) {
            throw new Error("Failed to resolve module: " + moduleName);
        }

        assert.isFunction(originalRequire);
        return originalRequire(resolvedModuleName);
    }

    //
    // Ensure modules required by the notebook.
    //
    private async ensureRequiredModules(notebook: INotebook, cells: ICell[], projectPath: string): Promise<void> {
        //
        // Automatically install modules referenced in the code.
        //
        for (const cell of cells) {
            if (cell.getCellType() === CellType.Code) {
                try {
                    await this.npm.ensureRequiredModules(cell.getText(), projectPath, false);
                }
                catch (err: any) {
                    await this.reportError(ErrorSource.ModuleInstall, cell.getId(), err.message, err.stack);
                }
            }
        }
    }

    //
    // Handle an uncaught exception in the user's notebook.
    //
    private onUncaughtException(err: Error): void {
        this.reportErrorSync(ErrorSource.CodeEvaluation, this.getCurCellId(), err.message, undefined, err.stack);
        this.onFinished();
    }

    //
    // Handle an unhandled rejected promise in the users' notebook.
    //
    private onUnhandledRejection (err: any, promise: Promise<any>): void {
        this.reportErrorSync(ErrorSource.CodeEvaluation, this.getCurCellId(), err && err.message, undefined, err && err.stack);
        this.onFinished();
    };

    //
    // Called when notebook evaluation has finished.
    //
    private onFinished(): void {
        if (this.notebookFinished) {
            // Already wound up.
            return;
        }

        // fs.writeSync(1, `%%--%% Finished evaluation, have ${this.asyncTracker.getNumAsyncOps()} async operations in progress.\n`);
        // fs.writeSync(1, this.asyncTracker.dump() + `\n`);

        this.notebookFinished = true;

        this.restoreOutput();

        if (this.sourceMap) {
            this.sourceMap.destroy();
            delete this.sourceMap;
        }

        this.asyncTracker.deinit();

        (this.process as EventEmitter).removeListener("uncaughtException", this.onUncaughtException);
        (this.process as EventEmitter).removeListener("unhandledRejection", this.onUnhandledRejection);

        this.log.info(">>> Evaluated code for notebook, async operations have completed.");

        if (this.onEvaluationCompleted) {
            this.onEvaluationCompleted();
        }
    }

    // remainingAsyncOps: number = 0;

    //
    // A function that starts an async checking loop to figure out when the notebook has completed.
    //
    private awaitNotebookCompleted(): void {
        if (this.notebookFinished) {
            // On finished has already been called.
            return;
        }

        if (this.timeout !== undefined) {
            const runningTime = performance.now() - this.startTime!;
            if (runningTime > this.timeout) {
                // Notebook has exceed its timeout.
                this.reportErrorSync(ErrorSource.CodeEvaluation, this.getCurCellId(), "Notebook exceeded timeout", undefined, undefined);
                this.onFinished();
                return;
            }
        }

        if (global.gc) {
            global.gc();
        }

        let allCellsCompleted = true;
        
        // const curAsyncOps = this.asyncTracker.getNumAsyncOps();
        // if (this.remainingAsyncOps !== curAsyncOps) {
        //     this.remainingAsyncOps = curAsyncOps;
        //     fs.writeSync(1, `%%--%% Have ${this.asyncTracker.getNumAsyncOps()} async operations in progress.\n`);
        //     fs.writeSync(1, this.asyncTracker.dump() + `\n`);
        // }

        for (let cellIndex = 0; cellIndex < this.numCells; ++cellIndex) {
            if (this.cellsCompleted[cellIndex]) {
                // fs.writeSync(1, (`%% Cell ${cellIndex} has already completed.\n`);
                continue; // This cell has already completed.
            }

            if (this.asyncTracker.hasCellCompleted(cellIndex)) {
                // The async operations for this cell have completed, clean up.
                // fs.writeSync(1, `%% Completed async evaluation for cell ${cellIndex}.\n`);
                this.cellsCompleted[cellIndex] = true;

                const getLocals = this.localsFnCache[cellIndex];
                if (getLocals) {
                    this.captureLocals(cellIndex, getLocals); // Do a final capture of local variables after async operations have completed.
                }

                if (this.onCellEvalEnded) {
                    this.onCellEvalEnded(this.cellIds[cellIndex]); // Notify listeners that this cell just completed.
                }
            }
            else {
                // At least 1 cell hasn't yet completed.
                allCellsCompleted = false;
            }
        }

        if (this.notebookCompleted && allCellsCompleted) { 
            // All cells have completed, we are done here.
            this.onFinished();
            return;
        }

        setTimeout(this.awaitNotebookCompleted, 0);
    };

    //
    // Marks the end of execution for a notebook, excluding indirect async operations.
    //
    private __end() {
        if (global.gc) {
            global.gc();
        }
        this.notebookCompleted = true; // Now just wait for the timer to kick in.
    };

    //
    // Captures local variables at the end of cell execution.
    //
    private __capture_locals(cellIndex: number, cellId: string, getLocals: () => any) {
        this.localsFnCache[cellIndex] = getLocals; // Keep a copy of this function so we can update locals again after async code has completed.
        this.captureLocals(cellIndex, getLocals);
    }

    //
    // Does an automatic display of the last value.
    //
    private __auto_display(value: any): void {
        this.display(value);
    }

    //
    // Capture local variables.
    //
    private captureLocals(cellIndex: number, getLocals: () => any) {

        const locals = getLocals();
        const keys = Object.keys(locals);
        fs.writeSync(1, `%% Captured locals for cell ${cellIndex}: ${JSON.stringify(keys)}`);

        for (const key of keys) {
            (global as any)[key] = locals[key]; //TODO: It's kind of wrong to set globals here. Should raise an event and do this at a higher level.
        }
    }

    //
    // Marks the evaluation of a new cell.
    // This is called in the async context of the notebook, be careful not to create any new async operations here.
    //
    private __cell(cellIndex: number, cellId: string, cellCode: Function): void { 

        // fs.writeSync(1, `%% Now evaluating cell [${cellIndex}]:${cellId}, current async context is ${executionAsyncId()}.\n`);

        if (this.notebookFinished) {
            fs.writeSync(1, `%% Notebook finished already, aborting cell evaluation.\n`);
            return;
        }

        if (global.gc) {
            global.gc();
        }

        if (this.onCellEvalStarted) {
            this.onCellEvalStarted(cellId);
        }

        //todo: Some of this code should be moved into the async tracker.
        const cellAsyncContext = new AsyncResource("__async_context");
        cellAsyncContext.runInAsyncScope(() => { // Run the code cell in its own async scope so it can be async tracked.
            const asyncContextId = executionAsyncId();
            fs.writeSync(1, `%% Running cell ${cellIndex} in new async context ${asyncContextId}.\n`);

            this.asyncTracker.init(); // Lazy init, just in time.
            this.asyncTracker.trackCell(asyncContextId, cellIndex);

            try {
                cellCode() // Run the cell code.
                    .catch((err: any) => { // Catch any direct async errors from the cell.
                        this.reportErrorSync(ErrorSource.CodeEvaluation, cellId, err.message, undefined, err.stack);
                        this.onFinished();
                    });
            }
            catch (err: any) { // Catch any direct non-async errors from the cell.
                this.reportErrorSync(ErrorSource.CodeEvaluation, cellId, err.message, undefined, err.stack);
                this.onFinished();
            }
        });
    }
        
    //
    // Evaluate code that was generated for a notebook.
    //
    private evalGeneratedCode(): void {

        let fn: any;
        const options: vm.RunningScriptOptions = {
            filename: this.fileName,
            displayErrors: true,
        };

        if (this.timeout !== undefined) {
            //
            // This doesn't take into account async code, so it's not the only solution for preventing
            // log running code, but it does prevent simple sync code like "while (true) {}" from locking up the
            // eval engine.
            //
            options.timeout = this.timeout;
        }

        try {
            fn = vm.runInThisContext(this.code!, options);
        }
        catch (err: any) {
            this.reportErrorSync(ErrorSource.CodeSetup, this.getCurCellId(), err.message, undefined, err.stack);
            return;
        }

        this.overrideOutput();

        this.startTime = performance.now();

        this.process.addListener("uncaughtException", this.onUncaughtException);
        this.process.addListener("unhandledRejection", this.onUnhandledRejection);

        try {
            fn(
                this.proxyRequire, 
                this.fileName, 
                this.projectPath, 
                this.display, 
                this.__cell, 
                this.__end,
                this.__capture_locals,
                this.__auto_display
            )
            .catch((err: any) => {
                this.reportErrorSync(ErrorSource.CodeEvaluation, this.getCurCellId(), err.message, undefined, err.stack);
                this.onFinished();
            });
        }
        catch (err: any) {
            this.reportErrorSync(ErrorSource.CodeEvaluation, this.getCurCellId(), err.message, undefined, err.stack);
            this.onFinished();
        }

        this.awaitNotebookCompleted(); // This is called outside the async context of the notebook, so async operations created here are not tracked.
    }

    //
    // Setup for evaluation.
    //
    private async evalSetup(): Promise<void> {
        //
        // Make sure the project is setup before evaluating.
        //
        const language = this.notebook.getLanguage();
        const projectGenerator = new ProjectGenerator(this.projectPath, language, this.npm, this.log);

        await projectGenerator.ensureProject(false);

        await this.ensureRequiredModules(this.notebook, this.cells, this.projectPath);

        this.log.info("Generating code for notebook " + this.fileName);
        this.log.info("Setting working dir to " + this.projectPath);
        this.process.chdir(this.projectPath);

        const codeGenerator = new CodeGenerator(this.notebook, this.projectPath, this.log);

        const generatedCode = await codeGenerator.genCode(this.cells);
        this.code = generatedCode.code;
        this.sourceMap = generatedCode.sourceMap;

        // if (this.code) {
        //     this.log.info("============= Generated code =============");
        //     this.log.info(this.code.split('\n').map((line, i) => (i+1).toString() + " : " + line).join('\n'));
        //     // this.log.info("============= Source map =================");
        //     // if (this.sourceMap) {
        //     //     this.log.info(JSON.stringify(this.sourceMap.getSourceMap(), null, 4));
        //     // }
        //     // else {
        //     //     this.log.info("No source map.");
        //     // }
        //     // this.log.info("==========================================");
        // }
        
        if (!this.code) {
            this.log.info("No code was produced, there may have been an error in the code.");
        }

        if (generatedCode.diagnostics && generatedCode.diagnostics.length > 0) {
            this.log.info("============= Diagnostics / errors =================");
            this.log.info(JSON.stringify(generatedCode.diagnostics, null, 4));
        }

        if (generatedCode.diagnostics && generatedCode.diagnostics.length) {
            for (const diagnostic of generatedCode.diagnostics) {
                await this.reportError(ErrorSource.Compiler, this.getCurCellId(), diagnostic.message, diagnostic.location, undefined);
            }
        }
    }

    //
    // Evaluate code for a notebook.
    //
    evalCode(): void {
        this.evalSetup()
            .then(() => {
                if (this.code) {
                    this.log.info("Evaluating code for notebook " + this.fileName);

                    this.evalGeneratedCode();
                }
                else {
                    this.onFinished();
                }
            })
            .catch(err => {
                this.log.error("An error occurred during evaluation setup.");
                this.log.error(err && err.stack || err);

                this.onFinished();
            });
    }

    //
    // Report an error back to the user.
    //
    private async reportError(
        errorSource: ErrorSource,
        curCellId: string, 
        errorMessage?: string, 
        errorLocation?: IFileLocation,
        errorStack?: string): Promise<void> {

        const fileName = this.fileName;
        this.log.info(`!! An error occurred while evaluating notebook "${fileName}" details follow.`);
        this.log.info("== Filename ==");
        this.log.info(fileName);
        this.log.info("== Error source ==");
        this.log.info(errorSource);
        this.log.info("== Cell id ==");
        this.log.info(curCellId || "<unknown>");
        this.log.info("== Error message ==");
        this.log.info(errorMessage || "<no-message>");
        this.log.info("== Error location ==");
        this.log.info(errorLocation && JSON.stringify(errorLocation, null, 4) || "<no-location>");
        this.log.info("== Error stacktrace ==");
        this.log.info(errorStack || "<no-stack-trace>");
        // this.log.info("== Error sourcemap ==");
        // this.log.info(this.sourceMap && JSON.stringify(this.sourceMap.getSourceMap(), null, 4) || "<no-source-map>");

        // this.log.info(JSON.stringify({
        //     fileName,
        //     errorSource,
        //     curCellId,
        //     errorMessage,
        //     errorLocation,
        //     errorStack,
        //     sourceMap: this.sourceMap && this.sourceMap.getSourceMap(),
        // }, null, 4));

        const errorMsg = await formatErrorMessage(fileName, errorSource, curCellId, errorMessage, errorLocation, errorStack, this.sourceMap);

        this.log.info("== Translated error message and stack trace ==");
        this.log.info(JSON.stringify(errorMsg, null, 4));
        // this.log.info("== ** ==");

        if (this.onError) {
            this.onError(errorMsg.cellId!, errorMsg.display);
        }
    }    

    //
    // Report an error back to the user.
    //
    private reportErrorSync(
        errorSource: ErrorSource,
        curCellId: string, 
        errorMessage?: string, 
        errorLocation?: IFileLocation,
        errorStack?: string): void {
        handleAsyncErrors(async () => {
            await this.reportError(errorSource, curCellId, errorMessage, errorLocation, errorStack);
        });
    }
}   