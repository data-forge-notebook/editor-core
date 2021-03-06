import * as React from 'react';
import * as monaco from 'monaco-editor';
import { Spinner } from '@blueprintjs/core';
import * as _ from 'lodash';
import { asyncHandler, debounceAsync, handleAsyncErrors, throttleAsync } from 'utils';
import { IFindDetails, IMonacoEditorViewModel, ITextRange, SearchDirection } from '../view-model/monaco-editor';
import { IEditorCaretPosition } from '../view-model/editor-caret-position';

let monacoInitialised = false;

function initializeMonaco() {
    if (monacoInitialised) {
        return;
    }

    monacoInitialised = true;

    // https://stackoverflow.com/a/57169408/25868
    monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
    monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);

    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true, //TODO: Want to enable this diagnostic options in the future.
        noSyntaxValidation: true,
    	noSuggestionDiagnostics: true,

    	// https://stackoverflow.com/questions/55116965/is-it-possible-to-remove-certain-errors-from-monaco-editor/71145347#71145347
    	diagnosticCodesToIgnore: [1375, 1378], // Allow "await" at the top level.
    });
    
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
    	noSuggestionDiagnostics: true,

    	// https://stackoverflow.com/questions/55116965/is-it-possible-to-remove-certain-errors-from-monaco-editor/71145347#71145347
    	diagnosticCodesToIgnore: [1375, 1378], // Allow "await" at the top level.
    });
    
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2016,
        allowNonTsExtensions: true,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monaco.languages.typescript.ModuleKind.CommonJS,
        noEmit: true,
        typeRoots: ["node_modules/@types"],
    });
    
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2016,
        allowNonTsExtensions: true,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monaco.languages.typescript.ModuleKind.CommonJS,
        noEmit: true,
        typeRoots: ["node_modules/@types"],
    });
}

declare const self: any;

self.MonacoEnvironment = {
    getWorkerUrl: function (moduleId: any, label: string): string {
        if (label === 'json') {
            return './json.worker.bundle.js';
        }
        if (label === 'css' || label === 'scss' || label === 'less') {
            return './css.worker.bundle.js';
        }
        if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return './html.worker.bundle.js';
        }
        if (label === 'typescript' || label === 'javascript') {
            return './ts.worker.bundle.js';
        }
        return './editor.worker.bundle.js';
    }
};

export interface IMonacoEditorProps {

    //
    // The language being edited.
    //
    language: string;

    //
    // The model for the editor.
    //
    model: IMonacoEditorViewModel;

    //
    // Sets the minimum height of the text editor.
    //
    minHeight?: number;

    //
    // Set to true to show the progress spinner.
    //
    working?: boolean;

    //
    // Callback when the escape key is pressed.
    //
    onEscapeKey?: () => void;

    //
    // Event raised when the height has changed.
    //
    onHeightChanged?: (newHeight: number) => void;
}

export interface IMonacoEditorState {
}

export class MonacoEditor extends React.Component<IMonacoEditorProps, IMonacoEditorState> {

    //
    // The HTML element that contains the text editor.
    //
    containerElement: React.RefObject<HTMLDivElement>;

    //
    // Container for the hidden Monaco editor used to compute the desired size of the visible Monaco editor.
    //
    hiddenContainerElement: React.RefObject<HTMLDivElement>;

    //
    // Models created for the editor.
    //
    editorModel: monaco.editor.IModel | null = null;

    
    // Docs
    // https://microsoft.github.io/monaco-editor/api/modules/monaco.editor.html
    editor: monaco.editor.IStandaloneCodeEditor | null = null;

    //
    // Hidden div that contains the hidden editor.
    //
    hiddenDiv?: HTMLDivElement;

    //
    // Hidden model.
    //
    hiddenModel: monaco.editor.IModel | null = null;

    //
    // Hidden editor used for calculating the expected size of the real editor.
    //
    hiddenEditor: monaco.editor.IStandaloneCodeEditor | null = null;

    //
    // Set to true when code is being updated into the model.
    //
    updatingCode: boolean = false;

    //
    // Debounced function to copy text from Monaco Editor to the view model.
    //
    updateTextInModel!: any;

    //
    // Cached Monaco caret element.
    //
    caretElement: Element | null = null;

    //
    // Disposables for Monaco editor events.
    //
    onDidChangeCursorPositionDisposable?: monaco.IDisposable;
    onDidChangeCursorSelectionDisposable?: monaco.IDisposable;
    onDidChangeModelContentDisposable?: monaco.IDisposable;
    
    //
    // The previous computed height of the editor.
    //
    prevComputedHeight?: number;

    constructor(props: any) {
        super(props);

        this.containerElement = React.createRef<HTMLDivElement>();
        this.hiddenContainerElement = React.createRef<HTMLDivElement>();

        this.state = {};

        this.onWindowResize = _.throttle(this.onWindowResize.bind(this), 400, { leading: false, trailing: true });
        this.onSetFocus = this.onSetFocus.bind(this);
        this.onSetCaretPosition = this.onSetCaretPosition.bind(this);
        this.onTextChanged = this.onTextChanged.bind(this);
        this.onFlushChanges = this.onFlushChanges.bind(this);
        this.props.model.caretPositionProvider = this.caretPositionProvider.bind(this);
        this.onEditorSelectionChanged = asyncHandler(this, this.onEditorSelectionChanged);
        this.onFindNextMatch = this.onFindNextMatch.bind(this);
        this.onSelectText = asyncHandler(this, this.onSelectText);
        this.onDeselectText = asyncHandler(this, this.onDeselectText);
        this.onReplaceText = asyncHandler(this, this.onReplaceText);
        
        // Throttle is used to not just to prevent too many updates, but also because
        // on the first cursor change after the Monaco Editor is focused the caret is
        // at the start of the editor, even when you clicked in the middle of the editor and this
        // causes screwy automatic scrolling of the notebook.
        // Throttling this update removes the initial 'bad scroll' on editor focus.
        this.onCursorPositionChanged = _.throttle(this.onCursorPositionChanged.bind(this), 100, { leading: false, trailing: true });
        this.onChangeCursorSelection = _.throttle(this.onChangeCursorSelection.bind(this), 300, { leading: false, trailing: true });
    }

    componentWillMount() {
        initializeMonaco();
    }

    componentDidMount() {
        const ext = this.props.language === "typescript" ? "ts" : "js"; //todo: is this needed?
        this.editorModel = monaco.editor.createModel(
            this.props.model.getText(),
            this.props.language
        );
        
        // https://microsoft.github.io/monaco-editor/api/interfaces/monaco.editor.ieditorconstructionoptions.html
        const options: monaco.editor.IStandaloneEditorConstructionOptions = {
            model: this.editorModel,
            codeLens: false,
            formatOnPaste: true,
            formatOnType: true,
            renderLineHighlight: "none",
            wordWrap: "on",
            selectionHighlight: false,
            contextmenu: false,
            readOnly: false,
            hideCursorInOverviewRuler: true,
            automaticLayout: false,
            scrollbar: {
                handleMouseWheel: false,
                vertical: "hidden",
                verticalScrollbarSize: 0,
            },
            minimap: {
                enabled: false,
            },
            scrollBeyondLastLine: false,
            lineNumbers: "off",
            links: false,
            glyphMargin: false,
            showUnused: false, // Have to turn this because it grays our variables that are used in other cells.
        };

        this.editor = monaco.editor.create(this.containerElement.current!, options);

        //
        // Create a whole hidden editor just to figure what size the editor should be.
        // This is pretty expensive but it avoids unecessary size changes and scrolling on the real editor.
        // Hope to find a better way to do this in the future.
        //

        this.hiddenModel = monaco.editor.createModel(
            this.props.model.getText(),
            this.props.language
        );
        
        // https://microsoft.github.io/monaco-editor/api/interfaces/monaco.editor.ieditorconstructionoptions.html
        const hiddenOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
            model: this.hiddenModel,
            codeLens: false,
            formatOnPaste: true,
            formatOnType: true,
            renderLineHighlight: "none",
            wordWrap: "on",
            selectionHighlight: false,
            contextmenu: false,
            readOnly: false,
            hideCursorInOverviewRuler: true,
            automaticLayout: false,
            scrollbar: {
                handleMouseWheel: false,
                vertical: "hidden",
                verticalScrollbarSize: 0,
            },
            minimap: {
                enabled: false,
            },
            scrollBeyondLastLine: false,
            lineNumbers: "off",
            links: false,
            glyphMargin: false,
            showUnused: false, // Have to turn this because it grays our variables that are used in other cells.
        };        

		//TODO: Be nice if this worked! Then I could share the hidden editor among multiple cells.
        // this.hiddenDiv = document.createElement("div"); 
        this.hiddenDiv = this.hiddenContainerElement.current!;
        this.hiddenEditor = monaco.editor.create(this.hiddenDiv, hiddenOptions);

        const updateEditorHeight = throttleAsync(
            this,
            this.updateEditorHeight,
            100
        );   

        this.updateTextInModel = debounceAsync(this, this.updateCode, 100);

        this.onDidChangeModelContentDisposable = this.editor.onDidChangeModelContent(
            () => {
                updateEditorHeight();
                if (!this.updatingCode) {
                    this.updateTextInModel(); // No need to pass text back to model when updating.
                }
            }
        );

        //TODO: Be good to type this properly.
        (this.editor as any)._contributions["editor.contrib.folding"].foldingModel.onDidChange((event: any) => {
            if (event.collapseStateChanged) {
                updateEditorHeight();
            }
        });

        this.onDidChangeCursorPositionDisposable = this.editor.onDidChangeCursorPosition(this.onCursorPositionChanged);
        this.onDidChangeCursorSelectionDisposable = this.editor.onDidChangeCursorSelection(this.onChangeCursorSelection);

        handleAsyncErrors(() => this.updateEditorHeight());
        window.addEventListener("resize", this.onWindowResize); //TODO: There should be one event handler for all monaco eidtors and it should debounced.


        if (this.props.onEscapeKey) {
            this.editor.addCommand(monaco.KeyCode.Escape, () => {
                this.props.onEscapeKey!();
            }, "");
        }

        this.props.model.onSetFocus.attach(this.onSetFocus);
        this.props.model.onSetCaretPosition.attach(this.onSetCaretPosition);
        this.props.model.onTextChanged.attach(this.onTextChanged);
        this.props.model.onFlushChanges.attach(this.onFlushChanges);
        this.props.model.onEditorSelectionChanged.attach(this.onEditorSelectionChanged);
        this.props.model.onFindNextMatch.attach(this.onFindNextMatch);
        this.props.model.onSelectText.attach(this.onSelectText);
        this.props.model.onDeselectText.attach(this.onDeselectText);
        this.props.model.onReplaceText.attach(this.onReplaceText);
        
    }

    componentWillUnmount () {

        if (this.onDidChangeModelContentDisposable) {
            this.onDidChangeModelContentDisposable.dispose();
            this.onDidChangeModelContentDisposable = undefined;
        }

        if (this.onDidChangeCursorPositionDisposable) {
            this.onDidChangeCursorPositionDisposable.dispose();
            this.onDidChangeCursorPositionDisposable = undefined;
        }

        if (this.onDidChangeCursorSelectionDisposable) {
            this.onDidChangeCursorSelectionDisposable.dispose();
            this.onDidChangeCursorSelectionDisposable = undefined;
        }

        if (this.editorModel) {
            this.editorModel.dispose();
            this.editorModel = null;
        }
        
        if (this.editor) {
            this.editor.dispose();
            this.editor = null;
        }

        if (this.hiddenModel) {
            this.hiddenModel.dispose();
            this.hiddenModel = null;
        }

        if (this.hiddenEditor) {
            this.hiddenEditor.dispose();
            this.hiddenEditor = null;
        }

        this.hiddenDiv = undefined;
        this.caretElement = null;

        window.removeEventListener("resize", this.onWindowResize);
        this.props.model.onSetFocus.detach(this.onSetFocus);
        this.props.model.onSetCaretPosition.detach(this.onSetCaretPosition);
        this.props.model.onTextChanged.detach(this.onTextChanged);
        this.props.model.onFlushChanges.detach(this.onFlushChanges);
        this.props.model.onEditorSelectionChanged.detach(this.onEditorSelectionChanged);
        this.props.model.onFindNextMatch.detach(this.onFindNextMatch);
        this.props.model.onSelectText.detach(this.onSelectText);
        this.props.model.onDeselectText.detach(this.onDeselectText);
        this.props.model.onReplaceText.detach(this.onReplaceText);
    }

    //
    // Event raised on request to find the next match.
    //
    private async onFindNextMatch(startingPosition: IEditorCaretPosition, searchDirection: SearchDirection, doSelection: boolean, findDetails: IFindDetails): Promise<void> {
        if (this.editorModel) {
            if (searchDirection === SearchDirection.Backward && startingPosition.lineNumber === -1) {
                // Need to search from the end of this cell.
                const fullRange = this.editorModel.getFullModelRange();
                startingPosition = {
                    lineNumber: fullRange.endLineNumber,
                    column: fullRange.endColumn,
                };
            }
            const wordSeparators = findDetails.matchWholeWord ? (this.editor?.getOptions() as any).wordSeparators : [];
            const findMatch = searchDirection === SearchDirection.Forward
                ? this.editorModel.findNextMatch(findDetails.text, startingPosition, false, findDetails.matchCase, wordSeparators, false)
                : this.editorModel.findPreviousMatch(findDetails.text, startingPosition, false, findDetails.matchCase, wordSeparators, false);
            if (findMatch) {
                await findDetails.notifyMatchFound(findMatch.range, searchDirection, doSelection);
                return;
            }
        }

        await findDetails.notifyMatchNotFound(searchDirection, doSelection);
    }

    //
    // Event raised when text should be selected.
    //
    private async onSelectText(range: ITextRange): Promise<void> {
        if (this.editor) {
            this.editor.setSelection(range);
        }
    }

    //
    // Event raised when text should be selected.
    //
    private async onDeselectText(): Promise<void> {
        if (this.editor) {
            this.editor.setSelection({ // This seems like a very hacky way to clear the selection, but it works and I couldn't a more official way.
                startLineNumber: 1, 
                startColumn: 1, 
                endLineNumber: 1, 
                endColumn: 1, 
            });
        }
    }    

    //
    // Event raised when text should be replaced.
    //
    private async onReplaceText(range: ITextRange, text: string): Promise<void> {
        if (this.editorModel) {
            await this.onDeselectText();
            this.editorModel.applyEdits([{
                range,
                text,
            }]);
            await this.updateTextInModel.flush(); // Flush text changes so we don't lose them.
        }
    }    

    //
    // Event raised when the selected editor has changed.
    //
    private async onEditorSelectionChanged(): Promise<void> {

        if (!this.editor) {
            return;
        }

        if (this.props.model.isSelected()) {
            this.editor.updateOptions({ lineNumbers: "on" });
            this.hiddenEditor!.updateOptions({ lineNumbers: "on" });
        }
        else {
            this.editor.updateOptions({ lineNumbers: "off" });
            this.hiddenEditor!.updateOptions({ lineNumbers: "off" });
        }
    }

    //
    // Flush text changes prior to saving.
    //
    private async onFlushChanges(): Promise<void> {
        const position = this.editor && this.editor.getPosition();
        await this.updateTextInModel.flush();
        if (this.editor) {
            this.editor.setPosition(position!);
        }
    }

    //
    // Get the rect of an element relative to the document.
    //
    private getElementRect(el: Element) {
        const rect = el.getBoundingClientRect();
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const top = rect.top + scrollTop;
        const left = rect.left + scrollLeft;
        return { 
            top, 
            left,
            right: left + rect.width,
            bottom: top + rect.height,
            width: rect.width,
            height: rect.height,
        };
    }

    //
    // Event raised the caret position changes.
    //
    private onCursorPositionChanged() {
        if (this.containerElement.current) {
            if (!this.caretElement) {
                this.caretElement = this.containerElement.current!.querySelector("textarea.inputarea"); // Get Monaco's caret.
            }

            if (this.caretElement) {
                const caretRect = this.getElementRect(this.caretElement);
                const caretHeight = 30;
                // this.caretRect = {
                //     left: caretRect.left - 5,
                //     top: caretRect.top - 5 - document.documentElement.scrollTop,
                //     width: 10,
                //     height: caretHeight,
                // };
                // this.forceUpdate();

                const caretBottom = caretRect.top + caretHeight;
                const windowHeight = (window.innerHeight || document.documentElement.clientHeight);
                const verticalGutter = 10;
                if (caretBottom >= document.documentElement.scrollTop + windowHeight) {
                    const newScrollTop = caretBottom - windowHeight + verticalGutter;
                    // console.log(`Cursor off bottom of screen, scrolling to: ${newScrollTop}`)
                    document.documentElement.scrollTop = newScrollTop;
                }
                else if (caretRect.top <= document.documentElement.scrollTop) {
                    const newScrollTop = caretRect.top - verticalGutter;
                    // console.log(`Cursor off bottom of screen, scrolling to: ${newScrollTop}`)
                    document.documentElement.scrollTop = newScrollTop;
                }
            }
        }

        if (this.editor && this.editorModel) {
            const caretPosition = this.editor.getPosition();
            const caretOffset = this.editorModel.getOffsetAt(caretPosition!);

            // 
            // Push caret offset into the view model.
            //
            this.props.model.setCaretOffset(caretOffset);
        }
    }
   
    //
    // Event raised when selection has changed.
    //
    private onChangeCursorSelection(event: any) {
        if (this.editorModel) {
            const selectedText = this.editorModel.getValueInRange(event.selection);
            this.props.model.setSelectedText(selectedText);
            this.props.model.setSelectedTextRange(event.selection);           
        }
    }

    //
    // Update code changes from the editor into the model.
    //
    private async updateCode(): Promise<void> {
        if (this.editor) {
            const updatedCode = this.editor.getValue();
            
            this.updatingCode = true;
            try {
                await this.props.model.setText(updatedCode);
            }
            finally {
                this.updatingCode = false;
            }
        }
    }

    //
    // Event raised to give this editor the focus.
    //
    private async onSetFocus(cell: IMonacoEditorViewModel): Promise<void> {
        if (this.editor) {
            this.editor.focus();
        }
    }

    //
    // Allows the view model to retreive the caret position.
    //
    private caretPositionProvider(): IEditorCaretPosition | null {
        if (this.editor) {
            return this.editor.getPosition();
        }
        else {
            return null;
        }
    }

    private async onSetCaretPosition(viewModel: IMonacoEditorViewModel, caretPosition: IEditorCaretPosition): Promise<void> {
        if (this.editor) {
            if (caretPosition) {
                this.editor.setPosition(caretPosition);
            }
        }
    }

    private async onTextChanged(): Promise<void> {
        if (!this.updatingCode) {
            if (this.editor) {
                const updatedCode = this.props.model.getText();
                if (this.editor.getValue() !== updatedCode) {
                    this.updatingCode = true;
                    try {
                        this.editor.setValue(updatedCode);
                    }
                    finally {
                        this.updatingCode = false;
                    }
                }
            }
        }
    }
   
    //
    // Update the editor height based on the content.
    //
    private async updateEditorHeight(): Promise<void> {
        if (!this.editor) {
            return;
        }

        //
        // https://github.com/Microsoft/monaco-editor/issues/103
        // https://github.com/theia-ide/theia/blob/bfaf5bb0d9a241bfa37f51e7ff9ca62de1755d1a/packages/monaco/src/browser/monaco-editor.ts#L274-L292
        //

        //
        // Force hidden editor render at 0 height.
        // Makes Monaco editor update its scroll height.
        //
        this.hiddenDiv!.style.height = "0px";
        this.hiddenEditor!.setValue(this.editor.getValue());
        this.hiddenEditor!.layout();

        //
        // Compute desired editor height from the hidden editor.
        //
        const minHeight = this.props.minHeight || 16;
        const gutter = 10;
        const contentHeight = this.hiddenEditor!.getScrollHeight() + gutter;
        const computedHeight = Math.max(minHeight, contentHeight);
        if (this.prevComputedHeight == computedHeight) {
            //
            // Don't do layout if we don't need it.
            //
            return;
        }

        // 
        // Reset height based on Monaco editor scroll height.
        //
        this.containerElement.current!.style.height = `${computedHeight}px`;
        this.editor!.layout();

        this.prevComputedHeight = computedHeight;

        if (this.props.onHeightChanged) {
            this.props.onHeightChanged(computedHeight);
        }
    }
    
    private onWindowResize(): void {
        //console.log("Detected window resize, updating editor height.");
        if (this.editor) {
        	this.editor.layout();
        }
    }    
    

    shouldComponentUpdate (nextProps: IMonacoEditorProps, nextState: IMonacoEditorState) {

        if (nextProps.working !== this.props.working) {
            this.forceUpdate(); //TODO: Shouldn't have to do this here.
        }

        if (this.editor!.getValue() !== nextProps.model.getText()) { //TODO: Is this really needed?
            this.editor!.setValue(nextProps.model.getText());
        }

        return false; // No need to ever rerender.
    }

    render () {
        return (
            <div className="pos-relative">
                <div 
                    ref={this.containerElement} 
                    />
                <div 
                    ref={this.hiddenContainerElement} 
                    style={{
                        overflow: "hidden",
                    }}
                    />
                { this.props.working
                    && <div 
                        style={{ 
                            position: "absolute",
                            left: "50%",
                            top: "50%",
                            marginLeft: "-25px",
                            marginTop: "-25px",
                            width: "50px",
                            height: "50px",
                        }}>
                        <Spinner />
                    </div>
                }

                {/* <div 
                    className="fixed"
                    style={{
                        top: `${this.caretRect?.top || "10"}px`,
                        left: `${this.caretRect?.left || "10"}px`,
                        width: `${this.caretRect?.width || "10"}px`,
                        height: `${this.caretRect?.height || "10"}px`,
                        border: "2px solid red",
                    }}
                    >

                </div> */}
            </div>
        );
    }
}