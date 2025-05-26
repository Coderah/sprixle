# manager
* manager should support threading by handling component updates & requests
* automatic entity & component pooling (reduce garbage collection)

# systems & pipelines

# queries
* queries, systems and consumers should work together to denote how utilized/active a query is. (allow for performance tooling and optimizations)
* Queries should recognize if they're within a worker and utilize WorkerTransport to tell the parent thread they are expecting updates.
* introduce Query warm/cold state? Allow queries to be manually warmed. Warm them as systems/consumers clearly denote usage. Warn when on-the-fly warming happens within a tick.

# threading
* introduce ThreadedPipeline
* utilize query utilization tracking to have a map of what state needs to be sent to the worker to allow it to run.
* ThreadedPipeline should have a `start` and `await finish` so they can be started inline with ticks and await at the end. Ideally there is also an option to let them run separate from top-level ticks and integrate updates as needed.
* figure out how to handle Manager within thread environment.

# three.js
* implement RendererPipeline plugin to standardize based on Brackish, SOBELOW, and LBT

# shaders
* implement FSR https://www.shadertoy.com/view/ftlSDX
* [LONGTERM] support WebGPU


# DONE
* Pipelines should be able to report on the performance graph.