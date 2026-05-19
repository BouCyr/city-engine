import * as SCATTER  from "./steps/000-scatter.mjs";
import * as GATHER  from "./steps/001-gather.mjs";

export const steps = [

  {title:"Scatter",
    process: SCATTER.scatterPoints,

  },
  {title:"Gather", process:GATHER.cells},
]
