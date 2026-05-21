import * as SCATTER  from "./steps/000-scatter.mjs";
import * as GATHER  from "./steps/001-gather.mjs";
import * as LLOYD  from "./steps/002-lloyd.mjs";

export const steps = [

  {title:"Scatter",
    process: SCATTER.scatterPoints,

  },
  {title:"Gather", process:GATHER.cells},
  {title:"Lloyd", process:LLOYD.relax},
]
