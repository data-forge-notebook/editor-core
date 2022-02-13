import * as React from "react";
import * as ReactDOM from "react-dom";
import { MonacoEditor } from "./components/monaco-editor";
import { PluggableVisualization } from "./notebook/cell/output/pluggable-visualization";
import { loadMonaco } from "./__fixtures__/load-monaco";
import "./__fixtures__/services/plugin-repository";

console.log("Loading Monaco...");
loadMonaco()
    .then(() => {
        console.log("Monaco loaded!");

        render();
    })
    .catch(err => {
        console.error("Failed to load Monaco!");
        console.error(err && err.stack || err);
    });


function App() {
    return (
        <div>
            <h1>Data-Forge Notebook: Browser testing environment</h1>
            <p>
                The code for DFN is incremently being open sourced and 
                there isn't much here yet.
            </p>
            <p>
                Watch this code repository grow week by week!
            </p>
            <MonacoEditor />       
            <hr />
            <h1>Cell output test:</h1>     
            <PluggableVisualization
                config={{
                    data: {
                        some: "data",
                        array: [1, 2, 3],
                    },
                }}
                />
        </div>
    );
}

function render() {
    ReactDOM.render(<App />, document.getElementById("root"));
}
