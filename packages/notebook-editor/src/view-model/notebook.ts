import { ICellViewModel } from "./cell";
import { INotebookCaretPosition } from "./notebook-caret-position";
import { IMonacoEditorViewModel } from "./monaco-editor";
import { CodeCellViewModel } from "./code-cell";
import { IEventSource, BasicEventHandler, EventSource, ILog, ILogId } from "utils";
import { CellType, ICell } from "model";
import { INotebook, Notebook } from "model";
import { ISerializedNotebook1 } from "model";
import * as path from "path";
import { MarkdownCellViewModel } from "./markdown-cell";
import { CellErrorViewModel } from "./cell-error";
import { CellOutputViewModel } from "./cell-output";
import { INotebookRepository, INotebookRepositoryId, INotebookStorageId } from "../services/notebook-repository";
import { InjectableClass, InjectProperty } from "@codecapers/fusion";
export type TextChangedEventHandler = (cell: ICellViewModel) => Promise<void>;

//
// Creates a cell view-model based on cell type.
//

export function cellViewModelFactory(cell: ICell): ICellViewModel {

    if (!cell) {
        throw new Error("Cell model not specified.");
    }

    const cellType = cell.getCellType();
    if (cellType === CellType.Code) {
        return new CodeCellViewModel(
            cell,
            cell.getOutput().map(output => new CellOutputViewModel(output)),
            cell.getErrors().map(error => new CellErrorViewModel(error))
        );
    }
    else if (cellType === CellType.Markdown) {
        return new MarkdownCellViewModel(cell);
    }
    else {
        throw new Error("Unexpected cell type: " + cellType);
    }
}

//
// The view-model for the entire notebook.
//
export interface INotebookViewModel {

    //
    // Get the storage id for the notebook, set to undefined when the notebook has not been saved.
    //
    getStorageId(): INotebookStorageId;

    //
    // Get the ID for this notebook instance.
    // This is not serialized and not persistant.
    //
    getInstanceId(): string;

    //
    // Get the language of the notebook.
    //
    getLanguage(): string;

    //
    // Get all cells in the notebook.
    //
    getCells(): ICellViewModel[];

    //
    // Get the position of a cell.
    //
    getCellIndex(cellViewModel: ICellViewModel): number;

    //
    // Get a cell by index.
    //
    getCellByIndex(cellIndex: number): ICellViewModel | undefined;

    //
    // Add an existing cell view model to the collection of cells.
    //
    addCell(cell: ICellViewModel, position: number): Promise<void>;

    //
    // Delete the cell from the notebook.
    //
    deleteCell(cell: ICellViewModel, selectNextCell: boolean): Promise<void>;

    //
    // Reorder cells.
    //
    moveCell(startIndex: number, endIndex: number): Promise<void>;

    //
    // Find a cell by id.
    //
    findCell(cellId: string): ICellViewModel | undefined;

    //
    // Find the next cell after the requested cell, or undefined if no more cells.
    //
    findNextCell(cellId: string): ICellViewModel | undefined;

    //
    // Find the prev cell before the requested cell, or undefined if no more cells.
    //
    findPrevCell(cellId: string): ICellViewModel | undefined;

    //
    // Get the first cell, or undefined if there are no cells.
    //
    getFirstCell(): ICellViewModel | undefined;

    //
    // Get the last cell, or undefined if there are no cells.
    //
    getLastCell(): ICellViewModel | undefined;

    //
    // Returns true if any cell in the notebook is executing.
    //
    isExecuting (): boolean;

    //
    // Event raised when the cells have changed.
    //
    onCellsChanged: IEventSource<BasicEventHandler>;

    //
    // Get the currently selected cell or undefined if none is selected.
    //
    getSelectedCell(): ICellViewModel | undefined;

    //
    // Deselect the currently selected cell, if any.
    //
    deselect(): Promise<void>;
   
    //
    // Event raised when the selected cell has changed.
    //
    onSelectedCellChanged: IEventSource<BasicEventHandler>;

    //  
    // Get the position of the caret in the notebook.
    //
    getCaretPosition(): INotebookCaretPosition | undefined;

    //
    // Get the index of the currently selected cell in the notebook.
    //
    getSelectedCellIndex(): number | undefined;

    //
    // Returns true if the notebook has never been saved.
    //
    isUnsaved(): boolean;

    //
    // Set to true if the notebook was loaded from a read only file.
    //
    isReadOnly(): boolean;

    //
    // Notify the notebook that it has been modified`.
    //
    notifyModified(): Promise<void>;

    //
    // Clears the modified flag.
    //
    clearModified(): Promise<void>;

    //
    // Determine if the notebook has been modified but not saved.
    //
    isModified(): boolean;

    //
    // Set or clear the modified state of the notebook.
    //
    setModified(modified: boolean): Promise<void>;

    //
    // Event raised when notebook has been modified.
    //
    onModified: IEventSource<BasicEventHandler>;

    //
    // Gets the Nodejs version for this notebook.
    //
    getNodejsVersion(): string;

    //
    // Sets the Nodejs version for this version.
    //
    setNodejsVersion(version: string): Promise<void>;

    //
    // Serialize to a data structure suitable for serialization.
    //
    serialize(): ISerializedNotebook1;

    //
    // Save the notebook to the current filename.
    //
    save(): Promise<void>;

    //
    // Save the notebook to a particular file.
    //
    saveAs(newStorageId: INotebookStorageId): Promise<void>;

    //
    // Clear all the outputs from the notebook.
    //
    clearOutputs(): Promise<void>;

    //
    // Clear all errors from the notebook.
    //
    clearErrors(): Promise<void>;

    //
    // Notify the model it is about to be saved.
    //
    flushChanges(): Promise<void>;

    //
    // Event raised before the model is saved.
    //
    onFlushChanges: IEventSource<BasicEventHandler>;

    //
    // Returns true if the notebook is currently executing.
    //
    isExecuting(): boolean;

    //
    // Start asynchronous evaluation of the notebook.
    //
    notifyCodeEvalStarted (): Promise<void>;

    //
    // Stop asynchronous evaluation of the notebook.
    //
    notifyCodeEvalComplete(): Promise<void>;

    //
    // Event raised when the notebook has started evaluation.
    //
    onEvalStarted: IEventSource<BasicEventHandler>;
    
    //
    // Event raised when the notebook has completed evaluation.
    //
    onEvalCompleted: IEventSource<BasicEventHandler>;

    //
    // Event raised when the text in this editor has changed.
    //
    onTextChanged: IEventSource<TextChangedEventHandler>;
}

@InjectableClass()
export class NotebookViewModel implements INotebookViewModel {

    @InjectProperty(ILogId)
    log!: ILog;
    
    @InjectProperty(INotebookRepositoryId)
    notebookRepository!: INotebookRepository;

    //
    // Identifies the notebook in storage.
    //
    private storageId: INotebookStorageId;

    //
    // The model underlying the view-model.
    //
    private notebook: INotebook;
    
    //
    // List of cells in the notebook.
    //
    private cells: ICellViewModel[];

    //
    // Set to true when the notebook is executing.
    //
    private executing: boolean = false;
    
    //
    // The currently selected cell.
    //
    private selectedCell: ICellViewModel | undefined;

    //
    // Set to true when the notebook is modified but not saved.
    //
    private modified: boolean;
    
    //
    // Caches the default Node.js version.
    //
    private defaultNodejsVersion: string;

    //
    // Set to true when the nottebook is unsaved in memory.
    //
    private unsaved: boolean;

    //
    // Set to true if the notebook was loaded from a read only file.
    //
    private readOnly: boolean;

    constructor(notebookStorageId: INotebookStorageId, notebook: INotebook, cells: ICellViewModel[], unsaved: boolean, readOnly: boolean, defaultNodeJsVersion: string) {
        this.storageId = notebookStorageId;
        this.notebook = notebook;
        this.defaultNodejsVersion = defaultNodeJsVersion;
        this.cells = cells;
        this.onEditorSelectionChanging = this.onEditorSelectionChanging.bind(this);
        this.onEditorSelectionChanged = this.onEditorSelectionChanged.bind(this);
        this.onCellModified = this.onCellModified.bind(this);
        this.modified = false;
        this.unsaved = unsaved;
        this.readOnly = readOnly;

        for (const cell of this.cells) {
            this.hookCellEvents(cell);
        }
    }

    private hookCellEvents(cell: ICellViewModel): void {
        cell.onEditorSelectionChanging.attach(this.onEditorSelectionChanging);
        cell.onEditorSelectionChanged.attach(this.onEditorSelectionChanged);
        cell.onModified.attach(this.onCellModified);
        cell.onTextChanged.attach(this._onTextChanged);
    }

    private unhookCellEvents(cell: ICellViewModel): void {
        cell.onEditorSelectionChanging.detach(this.onEditorSelectionChanging);
        cell.onEditorSelectionChanged.detach(this.onEditorSelectionChanged);
        cell.onModified.detach(this.onCellModified);
        cell.onTextChanged.detach(this._onTextChanged);
    }

    private async onEditorSelectionChanging(cell: IMonacoEditorViewModel, willBeSelected: boolean): Promise<void> {
        if (willBeSelected) {
            // 
            // Make sure everything else is selected before applying the new selection.
            //
            await this.deselect();
        }
    }

    private async onEditorSelectionChanged(cell: IMonacoEditorViewModel): Promise<void> {
        if (this.selectedCell === cell) {
            // Didn't change.
            return;
        }

        this.selectedCell = cell as ICellViewModel; //TODO: Is it possible to get rid of this cast? And others like it.
        await this.onSelectedCellChanged.raise();
    }

    //
    // Event raised when the text in a cell has changed.
    //
    private _onTextChanged = async (cell: IMonacoEditorViewModel): Promise<void> => {
        await this.onTextChanged.raise(cell as ICellViewModel);
    }

    //
    // Handles onCellModified from cells and bubbles the event upward.
    //
    private async onCellModified(cell: IMonacoEditorViewModel): Promise<void> {
        await this.notifyModified();
    }
  
    //
    // Get the storage id for the notebook, set to undefined when the notebook has not been saved.
    //
    getStorageId(): INotebookStorageId {
        return this.storageId;
    }

    //
    // Get the ID for this notebook instance.
    // This is not serialized and not persistant.
    //
    getInstanceId(): string {
        return this.notebook.getInstanceId();
    }

    //
    // Get the language of the notebook.
    //
    getLanguage(): string {
        return this.notebook.getLanguage();
    }

    //
    // Get all cells in the notebook.
    //
    getCells(): ICellViewModel[] {
        return this.cells;
    }

    //
    // Get the position of a cell.
    // Returns -1 if the cell wasn't found.
    //
    getCellIndex(cellViewModel: ICellViewModel): number {
        return this.getCells().indexOf(cellViewModel);
    }    

    //
    // Get a cell by index.
    //
    getCellByIndex(cellIndex: number): ICellViewModel | undefined {
        if (cellIndex >= 0 && cellIndex < this.getCells().length) {
            return this.getCells()[cellIndex];
        }
        
        return undefined;
    }

    //
    // Add an existing cell view model to the collection of cells.
    //
    async addCell(cellViewModel: ICellViewModel, cellIndex: number): Promise<void> {
        this.hookCellEvents(cellViewModel);

        await this.flushChanges();

        this.notebook.addCell(cellIndex, cellViewModel.getModel());
        
        this.cells.splice(cellIndex, 0, cellViewModel)
        await this.onCellsChanged.raise();

        await this.notifyModified();
    }

    //
    // Delete the cell from the notebook.
    //
    async deleteCell(cell: ICellViewModel, selectNextCell: boolean): Promise<void> {
        
        let nextSelectedCell = -1; // -1 Indicates no cell is selected next.
        const cells = this.getCells();
        const cellIndex = cells.indexOf(cell);
        if (cellIndex >= cells.length-1) {
            // Last cell is being deleted.
            if (cellIndex > 0) {
                nextSelectedCell = cellIndex-1; // Previous cell will be selected next.
            }
            else {
                // Only cell is being deleted.
            }
        }
        else {
            nextSelectedCell = cellIndex; // The cell after the deleted one will be selected next.
        }

        const cellId = cell.getId();
        this.notebook.deleteCell(cellId);

        const cellsRemoved = this.cells.filter(cell => cell.getId() === cellId);

        this.unhookCellEvents(cellsRemoved[0]);

        this.cells = this.cells.filter(cell => cell.getId() !== cellId);        
        await this.onCellsChanged.raise();

        if (selectNextCell && nextSelectedCell >= 0) {
            const nextFocusedCell = this.getCellByIndex(nextSelectedCell);
            if (nextFocusedCell) {
                await nextFocusedCell.select(); // Automatically focus, select and edit next cell.
            }
        }

        await this.notifyModified();
    }

    //
    // Move a cell from one index to another.
    //
    async moveCell(sourceIndex: number, destIndex: number): Promise<void> {

        this.notebook.moveCell(sourceIndex, destIndex);

        const reorderedCells = Array.from(this.cells);
        const [ movedCell ] = reorderedCells.splice(sourceIndex, 1);
        reorderedCells.splice(destIndex, 0, movedCell);
        this.cells = reorderedCells;
        await this.onCellsChanged.raise();
        await this.notifyModified();
    }

    //
    // Find the index of a cell given it's id.
    //
    private findCellIndex(cellId: string): number | undefined {
        let cellIndex = 0;
        while (cellIndex < this.cells.length) {
            if (this.cells[cellIndex].getId() === cellId) {
                return cellIndex;
            }
            cellIndex += 1;
        }

        return undefined;
    }

    //
    // Find a cell by id.
    //
    findCell(cellId: string): ICellViewModel | undefined {
        const cellIndex = this.findCellIndex(cellId)
        if (cellIndex === undefined) {
            return undefined;
        }

        return this.cells[cellIndex];
    }

    //
    // Find the next cell after the requested cell, or null if no more cells.
    //
    findNextCell(cellId: string): ICellViewModel | undefined {
        const cellIndex = this.findCellIndex(cellId);
        if (cellIndex === undefined) {
            return undefined;
        }

        let nextCellIndex = cellIndex+1;
        if (nextCellIndex < this.cells.length) {
            return this.cells[nextCellIndex];
        }

        return undefined;
    }

    //
    // Find the prev cell before the requested cell, or undefined if no more cells.
    //
    findPrevCell(cellId: string): ICellViewModel | undefined {
        const cellIndex = this.findCellIndex(cellId);
        if (cellIndex === undefined) {
            return undefined;
        }

        let prevCellIndex = cellIndex-1;
        if (prevCellIndex >= 0) {
            return this.cells[prevCellIndex];
        }

        return undefined;
    }
   
    //
    // Get the first cell, or undefined if there are no cells.
    //
    getFirstCell(): ICellViewModel | undefined {
        if (this.cells.length > 0) {
            return this.cells[0];
        }

        return undefined;
    }

    //
    // Get the last cell, or undefined if there are no cells.
    //
    getLastCell(): ICellViewModel | undefined {
        if (this.cells.length > 0) {
            return this.cells[this.cells.length-1];
        }

        return undefined;
    }

    //
    // Event raised when the cells have changed.
    //
    onCellsChanged: IEventSource<BasicEventHandler> = new EventSource<BasicEventHandler>();

    //
    // Get the currently selected cell.
    //
    getSelectedCell(): ICellViewModel | undefined {
        return this.selectedCell;
    }

    //
    // Deselect the currently selected cell, if any.
    //
    async deselect(): Promise<void> {
        if (this.selectedCell) {
            await this.selectedCell.deselect(); // Deselect previously selected.
            this.selectedCell = undefined;
        }
    }
    
    //
    // Event raised when the selected cell has changed.
    //
    onSelectedCellChanged: IEventSource<BasicEventHandler> = new EventSource<BasicEventHandler>();    

    //
    // Get the position of the caret in the notebook.
    //
    getCaretPosition(): INotebookCaretPosition | undefined {
        const selectedCell = this.getSelectedCell();
        if (selectedCell === undefined) {
            return undefined;
        }

        const selectedCellIndex = this.getSelectedCellIndex()!;
        const cellCaretPosition = selectedCell.getCaretPosition();
        if (cellCaretPosition === null) {
            return undefined;
        }

        const caretPosition: INotebookCaretPosition = {
            cellIndex: selectedCellIndex,
            cellPosition: cellCaretPosition,
        };
        return caretPosition;
    }

    //
    // Get the index of the currently selected cell in the notebook.
    //
    getSelectedCellIndex(): number | undefined {
        if (this.selectedCell === undefined) {
            return undefined;
        }

        return this.cells.indexOf(this.selectedCell);
    }

    //
    // Returns true if the notebook has never been saved.
    //
    isUnsaved(): boolean {
        return this.unsaved;
    }

    //
    // Set to true if the notebook was loaded from a read only file.
    //
    isReadOnly(): boolean {
        return this.readOnly;
    }

    //
    // Notify the notebook that it has been modified.
    //
    async notifyModified(): Promise<void> {
        this.setModified(true);
    }

    //
    // Clear the modified flag.
    //
    async clearModified(): Promise<void> {
        this.setModified(false);
    }

    //
    // Determine if the notebook has been modified but not saved.
    //
    isModified (): boolean {
        return this.modified;
    }

    //
    // Set or clear the modified state of the notebook.
    //
    async setModified(modified: boolean): Promise<void> {
        if (this.modified == modified) {
            return // No change.
        }
        this.modified = modified;
        await this.onModified.raise();
    }

    //
    // Event raised when data in the notebook has been modified.
    //
    onModified: IEventSource<BasicEventHandler> = new EventSource<BasicEventHandler>();

    //
    // Gets the Nodejs version for this notebook.
    //
    getNodejsVersion(): string {
        const curNodejsVersion = this.notebook.getNodejsVersion();
        return curNodejsVersion
            || this.defaultNodejsVersion;
    }

    //
    // Sets the Nodejs version for this version.
    //
    async setNodejsVersion(version: string): Promise<void> {
        this.notebook.setNodejsVersion(version);
        await this.notifyModified();
    }
    
    //
    // Serialize to a data structure suitable for serialization.
    //
    serialize(): ISerializedNotebook1 {
        return this.notebook.serialize();
    }

    //
    // Deserialize the model from a previously serialized data structure.
    //
    static deserialize(notebookStorageId: INotebookStorageId, unsaved: boolean, readOnly: boolean, defaultNodejsVersion: string, input: ISerializedNotebook1): INotebookViewModel {
        const notebook = Notebook.deserialize(input);
        const cells = notebook.getCells().map(cell => cellViewModelFactory(cell));
        return new NotebookViewModel(notebookStorageId, notebook, cells, unsaved, readOnly, defaultNodejsVersion);
    }

    //
    // Saves the notebook.
    //
    private async _save(notebookId: INotebookStorageId): Promise<void> {
        await this.flushChanges();

        const serialized = this.serialize();
        await this.notebookRepository.writeNotebook(serialized, notebookId);

        this.clearModified();
    }

    //
    // Save the notebook to the current filename.
    //
    async save(): Promise<void> {

        if (this.isReadOnly()) {
            throw new Error("The file for this notebook is readonly, it can't be saved this way.");
        }
        
        this.log.info("Saving notebook: " + this.storageId.toString());

        if (this.isUnsaved()) {
            throw new Error("Notebook has never been saved before, use saveAs function for the first save.");
        }

        await this._save(this.storageId);
        
        this.log.info("Saved notebook: " + this.storageId.toString());
    }

    //
    // Save the notebook to a new location.
    //
    async saveAs(newNotebookId: INotebookStorageId): Promise<void> {
    
		this.log.info("Saving notebook as: " + newNotebookId.toString());

		await this._save(newNotebookId);

        this.unsaved = false;
        this.storageId = newNotebookId;
        this.readOnly = false;
        
        this.log.info("Saved notebook as: " + newNotebookId.asPath());
    }

    //
    // Clear all the outputs from the notebook.
    //
    async clearOutputs(): Promise<void> {
        for (const cell of this.cells) {
            await cell.clearOutputs();
        }
    }

    //
    // Clear all errors from the notebook.
    //
    async clearErrors(): Promise<void> {
        for (const cell of this.cells) {
            await cell.clearErrors();
        }
    }

    //
    // Notify the model it is about to be saved.
    //
    async flushChanges(): Promise<void> {
        await this.onFlushChanges.raise();

        for (const cell of this.cells) {
            await cell.flushChanges();
        }
    }

    //
    // Event raised before the model is saved.
    //
    onFlushChanges: IEventSource<BasicEventHandler> = new EventSource<BasicEventHandler>();

    //
    // Returns true if the notebook is currently executing.
    //
    isExecuting(): boolean {
        return this.executing;
    }

    //
    // Start asynchronous evaluation of the notebook.
    //
    async notifyCodeEvalStarted (): Promise<void> {
        this.executing = true;
        for (const cell of this.getCells()) {
            cell.notifyNotebookEvalStarted();
        }
        
        await this.onEvalStarted.raise(); //TODO: Raising this event can potentially be moved up to the notebook view model.
    }

    //
    // Stop asynchronous evaluation of the notebook.
    //
    async notifyCodeEvalComplete(): Promise<void> {
        this.executing = false;

        for (const cell of this.getCells()) {
            await cell.notifyCodeEvalComplete(); // Make sure all cells are no longer marked as executing.
        }

        await this.onEvalCompleted.raise(); //TODO: Raising this event can potentially be moved up to the notebook view model.
    }

    //
    // Event raised when the notebook has started evaluation.
    //
    onEvalStarted: IEventSource<BasicEventHandler> = new EventSource<BasicEventHandler>();
    
    //
    // Event raised when the notebook has completed evaluation.
    //
    onEvalCompleted: IEventSource<BasicEventHandler> = new EventSource<BasicEventHandler>();

    //
    // Event raised when the text in this editor has changed.
    //
    onTextChanged: IEventSource<TextChangedEventHandler> = new EventSource<TextChangedEventHandler>();
}
