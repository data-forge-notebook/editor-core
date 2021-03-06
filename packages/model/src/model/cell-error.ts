import { ISerializedCellError1 } from "./serialization/serialized1";
import { v4 as uuid } from "uuid";

//
// Model for an error from a cell.
//

export interface ICellError {

    //
    // Get the (non-serialized) instance ID.
    //
    getInstanceId(): string;

    //
    // Get the message from the error.
    //
    getMsg(): string;

    //
    // Serialize to a data structure suitable for serialization.
    //
    serialize (): ISerializedCellError1;

    //
    // Returns true if this is fresh output.
    //
    isFresh(): boolean;

    //
    // Mark the output as out of data.
    //
    markStale(): void;
}

export class CellError implements ICellError {

    //
    // Instance ID of the model.
    // Not serialized.
    //
    private instanceId: string;

    //
    // The error message.
    //
    private msg: string;

    //
    // The output is fresh when true, out of date when false.
    //
    private fresh: boolean = true;
    
    constructor (msg: string) {
        this.instanceId = uuid();
        this.msg = msg;
    }

    //
    // Get the (non-serialized) instance ID.
    //
    getInstanceId(): string {
        return this.instanceId;
    }

    //
    // Get the message from the error.
    //
    getMsg(): string {
        return this.msg;
    }
    
    //
    // Serialize to a data structure suitable for serialization.
    //
    serialize(): ISerializedCellError1 {
        return {
            msg: this.msg
        };
    }    

    //
    // Deserialize the model from a previously serialized data structure.
    //
    static deserialize(input: ISerializedCellError1): ICellError {
        return new CellError(input.msg);
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
}