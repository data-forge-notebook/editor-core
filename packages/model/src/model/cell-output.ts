import { ISerializedCellOutput1 } from "./serialization/serialized1";
import { ICellOutputValue, CellOutputValue } from "./cell-output-value";
import { v4 as uuid } from "uuid";

//
// Model for output from a cell.
//

export interface ICellOutput {
    
    //
    // Get the (non-serialized) instance ID.
    //
    getInstanceId(): string;

    //
    // Get the value of the output.
    //
    getValue(): ICellOutputValue;

    //
    // Serialize to a data structure suitable for serialization.
    //
    serialize(): ISerializedCellOutput1;

    //
    // Returns true if this is fresh output.
    //
    isFresh(): boolean;

    //
    // Mark the output as out of data.
    //
    markStale(): void;

    //
    // Get the height of the output, if set.
    //
    getHeight(): number | undefined;

    //
    // Set the height of the output.
    //
    setHeight(height: number): void;
}

export class CellOutput implements ICellOutput {

    //
    // Instance ID of the model.
    //
    private instanceId: string;

    //
    // Actual value of the output.
    //
    private value: ICellOutputValue;

    //
    // Height of the output, if set.
    //
    private height?: number;

    //
    // The output is fresh when true, out of date when false.
    //
    private fresh: boolean = true;

    constructor(value: ICellOutputValue, height: number | undefined) {
        this.instanceId = uuid();
        this.value = value;
        this.height = height;
    }

    //
    // Get the (non-serialized) instance ID.
    //
    getInstanceId(): string {
        return this.instanceId;
    }
    
    //
    // Get the value of the output.
    //
    getValue(): ICellOutputValue {
        return this.value;
    }
    
    //
    // Serialize to a data structure suitable for serialization.
    //
    serialize (): ISerializedCellOutput1 {
        return {
            value: this.value.serialize(),
            height: this.height,
        };
    }    

    //
    // Deserialize the model from a previously serialized data structure.
    //
    static deserialize (input: ISerializedCellOutput1): ICellOutput {
        return new CellOutput(CellOutputValue.deserialize(input.value), input.height);
    }

    //
    // Returns true if this is fresh output.
    //
    isFresh(): boolean {
        return this.fresh;
    }

    //
    // Mark the output as out of data.
    //
    markStale(): void {
        this.fresh = false;
    }

    //
    // Get the height of the output, if set.
    //
    getHeight(): number | undefined {
        return this.height;
    }

    //
    // Set the height of the output.
    //
    setHeight(height: number): void {
        this.height = height;
    }

}