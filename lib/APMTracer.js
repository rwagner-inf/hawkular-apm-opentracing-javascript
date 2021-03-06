/*
 * Copyright 2015-2016 Red Hat, Inc. and/or its affiliates
 * and other contributors as indicated by the @author tags.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Constants from 'opentracing';

import { APMSpan } from './APMSpan';
import { APMSpanContext } from './APMSpanContext';
import { ConsoleRecorder } from './recorder';
import { AlwaysSample } from './sampler';
import { DEFAULT_META_DATA } from './deployment-meta-data';
import * as utils from './utils';
import * as constants from './constants';

const SAMPLER = Symbol('SAMPLER');
const RECORDER = Symbol('RECORDER');
const TRACE_DECORATOR = Symbol('TRACE_DECORATOR');

class APMTracer {
    constructor(prop = {}) {
        this[RECORDER] = prop.recorder || new ConsoleRecorder();
        this[SAMPLER] = prop.sampler || new AlwaysSample();

        const deploymentMetaData = prop.deploymentMetaData || DEFAULT_META_DATA;

        this[TRACE_DECORATOR] = function (trace) {
            const rootNode = trace.nodes[0];
            if (rootNode) {
                const span = rootNode.getSpan();
                if (!span) {
                    return;
                }

                if (deploymentMetaData.serviceName && !{}.hasOwnProperty.call(span.getTags(), constants.PROP_SERVICE_NAME)) {
                    span.setTag(constants.PROP_SERVICE_NAME, deploymentMetaData.serviceName);
                }
                if (deploymentMetaData.buildStamp && !{}.hasOwnProperty.call(span.getTags(), constants.PROP_BUILD_STAMP)) {
                    span.setTag(constants.PROP_BUILD_STAMP, deploymentMetaData.buildStamp);
                }
            }
        };
    }

    getSampler() {
        return this[SAMPLER];
    }

    getRecorder() {
        return this[RECORDER];
    }

    getTraceDecorator() {
        return this[TRACE_DECORATOR];
    }

    /**
     * Starts and returns a new Span representing a logical unit of work.
     *
     * For example:
     *
     *     // Start a new (parentless) root Span:
     *     var parent = Tracer.startSpan('DoWork');
     *
     *     // Start a new (child) Span:
     *     var child = Tracer.startSpan('Subroutine', {
     *         childOf: parent.context(),
     *     });
     *
     * @param {string} name - the name of the operation.
     * @param {object} [fields] - the fields to set on the newly created span.
     * @param {string} [fields.operationName] - the name to use for the newly
     *        created span. Required if called with a single argument.
     * @param {SpanContext} [fields.childOf] - a parent SpanContext (or Span,
     *        for convenience) that the newly-started span will be the child of
     *        (per REFERENCE_CHILD_OF). If specified, `fields.references` must
     *        be unspecified.
     * @param {array} [fields.references] - an array of Reference instances,
     *        each pointing to a causal parent SpanContext. If specified,
     *        `fields.childOf` must be unspecified.
     * @param {object} [fields.tags] - set of key-value pairs which will be set
     *        as tags on the newly created Span. Ownership of the object is
     *        passed to the created span for efficiency reasons (the caller
     *        should not modify this object after calling startSpan).
     * @param {number} [fields.startTime] - a manually specified start time for
     *        the created Span object. The time should be specified in
     *        milliseconds as Unix timestamp. Decimal value are supported
     *        to represent time values with sub-millisecond accuracy.
     * @return {Span} - a new Span object.
     */
    startSpan(name, fields) {
        const fieldsWithOperation = fields || {};
        fieldsWithOperation.operationName = name;
        return new APMSpan(this, fieldsWithOperation);
    }

    /**
     * Injects the given SpanContext instance for cross-process propagation
     * within `carrier`. The expected type of `carrier` depends on the value of
     * `format.
     *
     * OpenTracing defines a common set of `format` values (see
     * FORMAT_TEXT_MAP, FORMAT_HTTP_HEADERS, and FORMAT_BINARY), and each has
     * an expected carrier type.
     *
     * Consider this pseudocode example:
     *
     *     var clientSpan = ...;
     *     ...
     *     // Inject clientSpan into a text carrier.
     *     var headersCarrier = {};
     *     Tracer.inject(clientSpan.context(), Tracer.FORMAT_HTTP_HEADERS, headersCarrier);
     *     // Incorporate the textCarrier into the outbound HTTP request header
     *     // map.
     *     Object.assign(outboundHTTPReq.headers, headersCarrier);
     *     // ... send the httpReq
     *
     * @param  {SpanContext} spanContext - the SpanContext to inject into the
     *         carrier object. As a convenience, a Span instance may be passed
     *         in instead (in which case its .context() is used for the
     *         inject()).
     * @param  {string} format - the format of the carrier.
     * @param  {any} carrier - see the documentation for the chosen `format`
     *         for a description of the carrier object.
     */
    inject(spanContext, format, carrier) {
        if (!carrier) {
            console.log('Carrier should not be null!');
            return;
        }
        if (typeof carrier !== 'object') {
            console.log('Carrier is not object!');
            return;
        }

        if (spanContext instanceof APMSpan) {
            spanContext = spanContext.context();
        }

        switch (format) {
        case Constants.FORMAT_HTTP_HEADERS:
        case Constants.FORMAT_TEXT_MAP:
            APMTracer._injectHttpAndTextMap(spanContext, carrier);
            break;
        default:
            console.log('Inject unknown format!');
        }

        spanContext.getTrace().setNodeType(constants.NODE_TYPE_PRODUCER, spanContext, {
            value: carrier[constants.CARRIER_CORRELATION_ID],
            scope: constants.CORR_ID_SCOPE_INTERACTION,
        });
    }

    static _injectHttpAndTextMap(spanContext, carrier) {
        carrier[constants.CARRIER_TRACE_ID] = spanContext.getTraceId();
        carrier[constants.CARRIER_CORRELATION_ID] = utils.generateSpanId();
        if (spanContext.getTransaction()) {
            carrier[constants.CARRIER_TRANSACTION] = spanContext.getTransaction();
        }
        if (spanContext.getLevel()) {
            carrier[constants.CARRIER_LEVEL] = spanContext.getLevel();
        }
    }

    /**
     * Returns a SpanContext instance extracted from `carrier` in the given
     * `format`.
     *
     * OpenTracing defines a common set of `format` values (see
     * FORMAT_TEXT_MAP, FORMAT_HTTP_HEADERS, and FORMAT_BINARY), and each has
     * an expected carrier type.
     *
     * Consider this pseudocode example:
     *
     *     // Use the inbound HTTP request's headers as a text map carrier.
     *     var headersCarrier = inboundHTTPReq.headers;
     *     var wireCtx = Tracer.extract(Tracer.FORMAT_HTTP_HEADERS, headersCarrier);
     *     var serverSpan = Tracer.startSpan('...', { childOf : wireCtx });
     *
     * @param  {string} format - the format of the carrier.
     * @param  {any} carrier - the type of the carrier object is determined by
     *         the format.
     * @return {SpanContext}
     *         The extracted SpanContext, or null if no such SpanContext could
     *         be found in `carrier`
     */
    extract(format, carrier) {
        let spanContext;

        switch (format) {
        case Constants.FORMAT_HTTP_HEADERS:
        case Constants.FORMAT_TEXT_MAP:
            spanContext = APMTracer._extractHttpAndTextMap(carrier);
            break;
        default:
            console.log('Extract unknown format');
            spanContext = new APMSpanContext();
        }

        return spanContext;
    }

    static _extractHttpAndTextMap(carrier) {
        let correlationId = null;
        let traceId;
        let level;
        let transaction;
        Object.keys(carrier).forEach((objectKey) => {
            switch (objectKey.toUpperCase()) {
            case constants.CARRIER_CORRELATION_ID:
                correlationId = carrier[objectKey];
                break;
            case constants.CARRIER_TRACE_ID:
                traceId = carrier[objectKey];
                break;
            case constants.CARRIER_TRANSACTION:
                transaction = carrier[objectKey];
                break;
            case constants.CARRIER_LEVEL:
                level = carrier[objectKey];
                break;
            default:
            }
        });

        const spanContext = new APMSpanContext(utils.generateSpanId(), traceId, undefined, transaction, level);
        spanContext.setConsumerCorrelationId(correlationId);

        return spanContext;
    }
}

module.exports = {
    APMTracer,
};
