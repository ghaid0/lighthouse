/**
 * @license
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const Audit = require('./audit');
const Formatter = require('../formatters/formatter');
const URL = require('../lib/url-shim');

const KB_IN_BYTES = 1024;
const PREVIEW_LENGTH = 100;
const ALLOWABLE_UNUSED_RULES_RATIO = 0.10;

class UnusedCSSRules extends Audit {
  /**
   * @return {!AuditMeta}
   */
  static get meta() {
    return {
      category: 'CSS',
      name: 'unused-css-rules',
      description: 'Uses 90% of its CSS rules',
      helpText: 'Remove unused rules from stylesheets to reduce unnecessary ' +
          'bytes consumed by network activity. ' +
          '[Learn more](https://developers.google.com/speed/docs/insights/OptimizeCSSDelivery)',
      requiredArtifacts: ['CSSUsage', 'Styles', 'URL', 'networkRecords']
    };
  }

  /**
   * @param {!Array.<{header: {styleSheetId: string}}>} styles The output of the Styles gatherer.
   * @param {!Array<WebInspector.NetworkRequest>} networkRecords
   * @return {!Object} A map of styleSheetId to stylesheet information.
   */
  static indexStylesheetsById(styles, networkRecords) {
    const indexedNetworkRecords = networkRecords
        .filter(record => record._resourceType && record._resourceType._name === 'stylesheet')
        .reduce((indexed, record) => {
          indexed[record.url] = record;
          return indexed;
        }, {});
    return styles.reduce((indexed, stylesheet) => {
      indexed[stylesheet.header.styleSheetId] = Object.assign({
        used: [],
        unused: [],
        networkRecord: indexedNetworkRecords[stylesheet.header.sourceURL],
      }, stylesheet);
      return indexed;
    }, {});
  }

  /**
   * Counts the number of unused rules and adds count information to sheets.
   * @param {!Array.<{styleSheetId: string, used: boolean}>} rules The output of the CSSUsage gatherer.
   * @param {!Object} indexedStylesheets Stylesheet information indexed by id.
   * @return {number} The number of unused rules.
   */
  static countUnusedRules(rules, indexedStylesheets) {
    let unused = 0;

    rules.forEach(rule => {
      const stylesheetInfo = indexedStylesheets[rule.styleSheetId];

      if (!stylesheetInfo || stylesheetInfo.isDuplicate) {
        return;
      }

      if (rule.used) {
        stylesheetInfo.used.push(rule);
      } else {
        unused++;
        stylesheetInfo.unused.push(rule);
      }
    });

    return unused;
  }

  /**
   * Trims stylesheet content down to the first rule-set definition.
   * @param {string} content
   * @return {string}
   */
  static determineContentPreview(content) {
    let preview = content
        .slice(0, PREVIEW_LENGTH * 5)
        .replace(/( {2,}|\t)+/g, '  ') // remove leading indentation if present
        .replace(/\n\s+}/g, '\n}') // completely remove indentation of closing braces
        .trim(); // trim the leading whitespace

    if (preview.length > PREVIEW_LENGTH) {
      const firstRuleStart = preview.indexOf('{');
      const firstRuleEnd = preview.indexOf('}');

      if (firstRuleStart === -1 || firstRuleEnd === -1
          || firstRuleStart > firstRuleEnd
          || firstRuleStart > PREVIEW_LENGTH) {
        // We couldn't determine the first rule-set or it's not within the preview
        preview = preview.slice(0, PREVIEW_LENGTH) + '...';
      } else if (firstRuleEnd < PREVIEW_LENGTH) {
        // The entire first rule-set fits within the preview
        preview = preview.slice(0, firstRuleEnd + 1) + ' ...';
      } else {
        // The first rule-set doesn't fit within the preview, just show as many as we can
        const lastSemicolonIndex = preview.slice(0, PREVIEW_LENGTH).lastIndexOf(';');
        preview = lastSemicolonIndex < firstRuleStart ?
            preview.slice(0, PREVIEW_LENGTH) + '... } ...' :
            preview.slice(0, lastSemicolonIndex + 1) + ' ... } ...';
      }
    }

    return preview;
  }

  /**
   * @param {!Object} stylesheetInfo The stylesheetInfo object.
   * @param {string} pageUrl The URL of the page, used to identify inline styles.
   * @return {!{url: string, label: string, code: string}} The result for the URLLIST formatter.
   */
  static mapSheetToResult(stylesheetInfo, pageUrl) {
    const numUsed = stylesheetInfo.used.length;
    const numUnused = stylesheetInfo.unused.length;

    if ((numUsed === 0 && numUnused === 0) || stylesheetInfo.isDuplicate) {
      return null;
    }

    let url = stylesheetInfo.header.sourceURL;
    if (!url || url === pageUrl) {
      const contentPreview = UnusedCSSRules.determineContentPreview(stylesheetInfo.content);
      url = '*inline*```' + contentPreview + '```';
    } else {
      url = URL.getDisplayName(url);
    }

    // If we don't know for sure how many bytes this sheet used on the network,
    // we can guess it was roughly the size of the content gzipped.
    const totalBytes = stylesheetInfo.networkRecord ?
        stylesheetInfo.networkRecord.transferSize :
        Math.round(stylesheetInfo.content.length / 3);

    const percentUnused = numUnused / (numUsed + numUnused);
    const wastedBytes = Math.round(percentUnused * totalBytes);

    return {
      url,
      numUnused,
      wastedBytes,
      totalKb: Math.round(totalBytes / KB_IN_BYTES) + ' KB',
      potentialSavings: `${Math.round(percentUnused * 100)}%`,
    };
  }

  /**
   * @param {!Artifacts} artifacts
   * @return {!AuditResult}
   */
  static audit(artifacts) {
    const networkRecords = artifacts.networkRecords[Audit.DEFAULT_PASS];
    return artifacts.requestNetworkThroughput(networkRecords).then(networkThroughput => {
      return UnusedCSSRules.audit_(artifacts, networkThroughput);
    });
  }

  /**
   * @param {!Artifacts} artifacts
   * @param {number} networkThroughput
   * @return {!AuditResult}
   */
  static audit_(artifacts, networkThroughput) {
    const styles = artifacts.Styles;
    const usage = artifacts.CSSUsage;
    const pageUrl = artifacts.URL.finalUrl;
    const networkRecords = artifacts.networkRecords[Audit.DEFAULT_PASS];

    const indexedSheets = UnusedCSSRules.indexStylesheetsById(styles, networkRecords);
    const unused = UnusedCSSRules.countUnusedRules(usage, indexedSheets);
    const unusedRatio = (unused / usage.length) || 0;
    const results = Object.keys(indexedSheets).map(sheetId => {
      return UnusedCSSRules.mapSheetToResult(indexedSheets[sheetId], pageUrl);
    }).filter(Boolean);

    const wastedBytes = results.reduce((waste, result) => waste + result.wastedBytes, 0);
    let displayValue = '';
    if (unused > 0) {
      const wastedKb = Math.round(wastedBytes / KB_IN_BYTES);
      // Only round to nearest 10ms since we're relatively hand-wavy
      const wastedMs = Math.round(wastedBytes / networkThroughput * 100) * 10;
      displayValue = `${wastedKb}KB (~${wastedMs}ms) potential savings`;
    }

    return UnusedCSSRules.generateAuditResult({
      displayValue,
      rawValue: unusedRatio < ALLOWABLE_UNUSED_RULES_RATIO,
      extendedInfo: {
        formatter: Formatter.SUPPORTED_FORMATS.TABLE,
        value: {
          results,
          tableHeadings: {
            url: 'URL',
            numUnused: 'Unused Rules',
            totalKb: 'Original (KB)',
            potentialSavings: 'Potential Savings (%)',
          }
        }
      }
    });
  }
}

module.exports = UnusedCSSRules;