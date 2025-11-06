import { noop } from 'lodash';
import { Pipeline, System } from './system';
import { Manager } from './manager';

let startPerformanceMeasure: (
    target: Pipeline<any> | System<any, any, any> | Manager<any>,
    detail?: Object
) => void = noop;
let endPerformanceMeasure: (
    target: Pipeline<any> | System<any, any, any> | Manager<any>,
    detail?: Object
) => void = noop;

if (process.env.NODE_ENV !== 'production') {
    globalThis['trackPerformance'] = function () {
        startPerformanceMeasure = (target, detail = {}) => {
            const tag =
                target instanceof Manager
                    ? 'Manager.internal'
                    : target.tag || 'Unknown';
            performance.mark(tag + ' start', { detail });
        };
        endPerformanceMeasure = (target, detail) => {
            const tag =
                target instanceof Manager
                    ? 'Manager.internal'
                    : target.tag || 'Unknown';
            performance.mark(tag + ' end', {
                detail,
            });
            performance.measure(tag, tag + ' start', tag + ' end');
        };
    };

    globalThis['stopTrackingPerformance'] = function () {
        startPerformanceMeasure = noop;
        endPerformanceMeasure = noop;

        performance.clearMarks();
        performance.clearMeasures();
    };
}

export { startPerformanceMeasure, endPerformanceMeasure };
