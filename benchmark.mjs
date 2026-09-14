import { runLeakageBenchmark } from './dist/index.js';
const report=runLeakageBenchmark();
console.log(JSON.stringify(report,null,2));
if(report.cases.some(item=>!item.detected||!item.canariesRemoved||!item.reviewComplete||item.remainingBlocking))process.exitCode=1;
