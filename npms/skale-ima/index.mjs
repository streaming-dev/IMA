// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @license
 * SKALE IMA
 *
 * SKALE IMA is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * SKALE IMA is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with SKALE IMA.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * @file index.mjs
 * @copyright SKALE Labs 2019-Present
 */

// init very basics
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as child_process from "child_process";

import { UniversalDispatcherEvent, EventDispatcher } from "../skale-cool-socket/event_dispatcher.mjs";

import * as Redis from "ioredis";
import * as ethereumjs_util from "ethereumjs-util";

import * as log from "../skale-log/log.mjs";
import * as cc from "../skale-cc/cc.mjs";
// log.add( strFilePath, nMaxSizeBeforeRotation, nMaxFilesCount ); // example: log output to file

import * as owaspUtils from "../skale-owasp/owasp-utils.mjs";
import * as loop from "../../agent/loop.mjs";
import * as pwa from "../../agent/pwa.mjs";

import * as state from "../../agent/state.mjs";

const __dirname = path.dirname( url.fileURLToPath( import.meta.url ) );

let redis = null;
let loopTmSendingCnt = 0;
cc.enable( false );
log.addStdout();

export const longSeparator = "=======================================================================================================================";

const perMessageGasForTransfer = 1000000;
const additionalS2MTransferOverhead = 200000;

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// logging helpers
//
const mapVERBOSE = {
    0: "silent",
    2: "fatal",
    3: "error",
    4: "warning",
    5: "attention",
    6: "information",
    7: "notice",
    8: "debug",
    9: "trace"
};
function compute_VERBOSE_alias() {
    const m = {};
    for( const key in mapVERBOSE ) {
        if( !mapVERBOSE.hasOwnProperty( key ) )
            continue; // skip loop if the property is from prototype
        const name = mapVERBOSE[key];
        m[name] = key;
    }
    m.warn = m.warning; // alias
    m.info = m.information; // alias
    return m;
}
const mapRV_VERBOSE = compute_VERBOSE_alias();

export function VERBOSE() { return mapVERBOSE; };
export function RV_VERBOSE() { return mapRV_VERBOSE; };

let g_isExposeDetails = false;
let g_verboseLevel = RV_VERBOSE().info;

export function expose_details_get() {
    return g_isExposeDetails;
}
export function expose_details_set( x ) {
    g_isExposeDetails = x ? true : false;
}

export function verbose_get() {
    return g_verboseLevel;
}
export function verbose_set( x ) {
    g_verboseLevel = x;
}

export function verbose_parse( s ) {
    let n = 5;
    try {
        const isNumbersOnly = /^\d+$/.test( s );
        if( isNumbersOnly )
            n = owaspUtils.toInteger( s );
        else {
            const ch0 = s[0].toLowerCase();
            for( const key in mapVERBOSE ) {
                if( !mapVERBOSE.hasOwnProperty( key ) )
                    continue; // skip loop if the property is from prototype
                const name = mapVERBOSE[key];
                const ch1 = name[0].toLowerCase();
                if( ch0 == ch1 ) {
                    n = key;
                    break;
                }
            }
        }
    } catch ( err ) {}
    return n;
}

export function verbose_list() {
    for( const key in mapVERBOSE ) {
        if( !mapVERBOSE.hasOwnProperty( key ) )
            continue; // skip loop if the property is from prototype
        const name = mapVERBOSE[key];
        console.log( "    " + cc.info( key ) + cc.sunny( "=" ) + cc.bright( name ) );
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const g_nSleepBeforeFetchOutgoingMessageEvent = 5000;
let g_nSleepBetweenTransactionsOnSChainMilliseconds = 0; // example - 5000
let g_bWaitForNextBlockOnSChain = false;

export function getSleepBetweenTransactionsOnSChainMilliseconds() {
    return g_nSleepBetweenTransactionsOnSChainMilliseconds;
}
export function setSleepBetweenTransactionsOnSChainMilliseconds( val ) {
    g_nSleepBetweenTransactionsOnSChainMilliseconds = val ? val : 0;
}

export function getWaitForNextBlockOnSChain() {
    return g_bWaitForNextBlockOnSChain ? true : false;
}
export function setWaitForNextBlockOnSChain( val ) {
    g_bWaitForNextBlockOnSChain = val ? true : false;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const sleep = ( milliseconds ) => { return new Promise( resolve => setTimeout( resolve, milliseconds ) ); };
export const current_timestamp = () => { return parseInt( parseInt( Date.now().valueOf() ) / 1000 ); };

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function safe_waitForNextBlockToAppear( details, ethersProvider ) {
    const nBlockNumber = owaspUtils.toBN( await safe_getBlockNumber( details, 10, ethersProvider ) );
    details.write( cc.debug( "Waiting for next block to appear..." ) + "\n" );
    details.write( cc.debug( "    ...have block " ) + cc.info( nBlockNumber.toHexString() ) + "\n" );
    for( ; true; ) {
        await sleep( 1000 );
        const nBlockNumber2 = owaspUtils.toBN( await safe_getBlockNumber( details, 10, ethersProvider ) );
        details.write( cc.debug( "    ...have block " ) + cc.info( nBlockNumber2.toHexString() ) + "\n" );
        if( nBlockNumber2.gt( nBlockNumber ) )
            break;
    }
}

export async function safe_getBlockNumber( details, cntAttempts, ethersProvider, retValOnFail, throwIfServerOffline ) {
    const strFnName = "getBlockNumber";
    const u = owaspUtils.ep_2_url( ethersProvider );
    const nWaitStepMilliseconds = 10 * 1000;
    if( throwIfServerOffline == null || throwIfServerOffline == undefined )
        throwIfServerOffline = true;
    cntAttempts = owaspUtils.parseIntOrHex( cntAttempts ) < 1 ? 1 : owaspUtils.parseIntOrHex( cntAttempts );
    if( retValOnFail == null || retValOnFail == undefined )
        retValOnFail = "";
    let idxAttempt = 1;
    let ret = retValOnFail;
    try {
        ret = await ethersProvider[strFnName]();
        return ret;
    } catch ( err ) {
        ret = retValOnFail;
        details.write(
            cc.error( "Failed call attempt " ) + cc.info( idxAttempt ) +
            cc.error( " to " ) + cc.note( strFnName + "()" ) +
            cc.error( " via " ) + cc.u( u ) +
            cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
            "\n" );
    }
    ++ idxAttempt;
    while( ret === "" && idxAttempt <= cntAttempts ) {
        const isOnLine = rpcCall.check_url( u, nWaitStepMilliseconds );
        if( ! isOnLine ) {
            ret = retValOnFail;
            if( ! throwIfServerOffline )
                return ret;
            details.write(
                cc.error( "Cannot call " ) + cc.note( strFnName + "()" ) + cc.error( " via " ) + cc.u( u ) +
                cc.warning( " because server is off-line" ) + "\n" );
            throw new Error( "Cannot " + strFnName + "() via " + u.toString() + " because server is off-line" );
        }
        details.write(
            cc.warning( "Repeat call to " ) + cc.note( strFnName + "()" ) +
            cc.error( " via " ) + cc.u( u ) +
            cc.warning( ", attempt " ) + cc.info( idxAttempt ) +
            "\n" );
        // await sleep( nWaitStepMilliseconds );
        try {
            ret = await ethersProvider[strFnName]();
            return ret;
        } catch ( err ) {
            ret = retValOnFail;
            details.write(
                cc.error( "Failed call attempt " ) + cc.info( idxAttempt ) +
                cc.error( " to " ) + cc.note( strFnName + "()" ) +
                cc.error( " via " ) + cc.u( u ) +
                cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
                cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                "\n" );
        }
        ++ idxAttempt;
    }
    if( ( idxAttempt + 1 ) > cntAttempts && ret === "" ) {
        details.write( cc.fatal( "ERROR:" ) +
            cc.error( " Failed call to " ) + cc.note( strFnName + "()" ) +
            + cc.error( " via " ) + cc.u( u ) + cc.error( " after " ) + cc.info( cntAttempts ) + cc.error( " attempts " ) +
            "\n" );
        throw new Error( "Failed call to " + strFnName + "() via " + u.toString() + " after " + cntAttempts + " attempts" );
    }
    return ret;
}

export async function safe_getTransactionCount( details, cntAttempts, ethersProvider, address, param, retValOnFail, throwIfServerOffline ) {
    const strFnName = "getTransactionCount";
    const u = owaspUtils.ep_2_url( ethersProvider );
    const nWaitStepMilliseconds = 10 * 1000;
    if( throwIfServerOffline == null || throwIfServerOffline == undefined )
        throwIfServerOffline = true;
    cntAttempts = owaspUtils.parseIntOrHex( cntAttempts ) < 1 ? 1 : owaspUtils.parseIntOrHex( cntAttempts );
    if( retValOnFail == null || retValOnFail == undefined )
        retValOnFail = "";
    let ret = retValOnFail;
    let idxAttempt = 1;
    try {
        ret = await ethersProvider[strFnName]( address, param );
        return ret;
    } catch ( err ) {
        ret = retValOnFail;
        details.write(
            cc.error( "Failed call attempt " ) + cc.info( idxAttempt ) +
            cc.error( " to " ) + cc.note( strFnName + "()" ) +
            cc.error( " via " ) + cc.u( u ) +
            cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
            "\n" );
    }
    ++ idxAttempt;
    while( ret === "" && idxAttempt <= cntAttempts ) {
        const isOnLine = rpcCall.check_url( u, nWaitStepMilliseconds );
        if( ! isOnLine ) {
            ret = retValOnFail;
            if( ! throwIfServerOffline )
                return ret;
            details.write(
                cc.error( "Cannot call " ) + cc.note( strFnName + "()" ) + cc.error( " via " ) + cc.u( u ) +
                cc.warning( " because server is off-line" ) + "\n" );
            throw new Error( "Cannot " + strFnName + "() via " + u.toString() + " because server is off-line" );
        }
        details.write(
            cc.warning( "Repeat call to " ) + cc.note( strFnName + "()" ) +
            cc.error( " via " ) + cc.u( u ) +
            cc.warning( ", attempt " ) + cc.info( idxAttempt ) +
            "\n" );
        // await sleep( nWaitStepMilliseconds );
        try {
            ret = await ethersProvider[strFnName]( address, param );
            return ret;
        } catch ( err ) {
            ret = retValOnFail;
            details.write(
                cc.error( "Failed call attempt " ) + cc.info( idxAttempt ) +
                cc.error( " to " ) + cc.note( strFnName + "()" ) +
                cc.error( " via " ) + cc.u( u ) +
                cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
                cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                "\n" );
        }
        ++ idxAttempt;
    }
    if( ( idxAttempt + 1 ) > cntAttempts && ret === "" ) {
        details.write( cc.fatal( "ERROR:" ) +
            cc.error( " Failed call to " ) + cc.note( strFnName + "()" ) +
            + cc.error( " via " ) + cc.u( u ) + cc.error( " after " ) + cc.info( cntAttempts ) + cc.error( " attempts " ) +
            "\n" );
        throw new Error( "Failed call to " + strFnName + "() via " + u.toString() + " after " + cntAttempts + " attempts" );
    }
    return ret;
}

export async function safe_getTransactionReceipt( details, cntAttempts, ethersProvider, txHash, retValOnFail, throwIfServerOffline ) {
    const strFnName = "getTransactionReceipt";
    const u = owaspUtils.ep_2_url( ethersProvider );
    const nWaitStepMilliseconds = 10 * 1000;
    if( throwIfServerOffline == null || throwIfServerOffline == undefined )
        throwIfServerOffline = true;
    cntAttempts = owaspUtils.parseIntOrHex( cntAttempts ) < 1 ? 1 : owaspUtils.parseIntOrHex( cntAttempts );
    if( retValOnFail == null || retValOnFail == undefined )
        retValOnFail = "";
    let ret = retValOnFail;
    let idxAttempt = 1;
    try {
        ret = await ethersProvider[strFnName]( txHash );
        return ret;
    } catch ( err ) {
        ret = retValOnFail;
        details.write(
            cc.error( "Failed call attempt " ) + cc.info( idxAttempt ) +
            cc.error( " to " ) + cc.note( strFnName + "()" ) +
            cc.error( " via " ) + cc.u( u ) +
            cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
            "\n" );
    }
    ++ idxAttempt;
    while( txReceipt === "" && idxAttempt <= cntAttempts ) {
        const isOnLine = rpcCall.check_url( u, nWaitStepMilliseconds );
        if( ! isOnLine ) {
            ret = retValOnFail;
            if( ! throwIfServerOffline )
                return ret;
            details.write(
                cc.error( "Cannot call " ) + cc.note( strFnName + "()" ) + cc.error( " via " ) + cc.u( u ) +
                cc.warning( " because server is off-line" ) + "\n" );
            throw new Error( "Cannot " + strFnName + "() via " + u.toString() + " because server is off-line" );
        }
        details.write(
            cc.warning( "Repeat call to " ) + cc.note( strFnName + "()" ) +
            cc.error( " via " ) + cc.u( u ) +
            cc.warning( ", attempt " ) + cc.info( idxAttempt ) +
            "\n" );
        // await sleep( nWaitStepMilliseconds );
        try {
            ret = await ethersProvider[strFnName]( txHash );
            return ret;
        } catch ( err ) {
            ret = retValOnFail;
            details.write(
                cc.error( "Failed call attempt " ) + cc.info( idxAttempt ) +
                cc.error( " to " ) + cc.note( strFnName + "()" ) +
                cc.error( " via " ) + cc.u( u ) +
                cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
                cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                "\n" );
        }
        ++ idxAttempt;
    }
    if( ( idxAttempt + 1 ) > cntAttempts && ( txReceipt === "" || txReceipt === undefined ) ) {
        details.write( cc.fatal( "ERROR:" ) +
            cc.error( " Failed call to " ) + cc.note( strFnName + "()" ) +
            + cc.error( " via " ) + cc.u( u ) + cc.error( " after " ) + cc.info( cntAttempts ) + cc.error( " attempts " ) +
            "\n" );
        throw new Error( "Failed call to " + strFnName + "() via " + u.toString() + " after " + cntAttempts + " attempts" );
    }
    return ret;
}

export async function safe_getPastEvents( details, ethersProvider, cntAttempts, joContract, strEventName, nBlockFrom, nBlockTo, joFilter, retValOnFail, throwIfServerOffline ) {
    const u = owaspUtils.ep_2_url( ethersProvider );
    const nWaitStepMilliseconds = 10 * 1000;
    if( throwIfServerOffline == null || throwIfServerOffline == undefined )
        throwIfServerOffline = true;
    cntAttempts = owaspUtils.parseIntOrHex( cntAttempts ) < 1 ? 1 : owaspUtils.parseIntOrHex( cntAttempts );
    if( retValOnFail == null || retValOnFail == undefined )
        retValOnFail = "";
    let ret = retValOnFail;
    let idxAttempt = 1;
    const strErrorTextAboutNotExistingEvent = "Event \"" + strEventName + "\" doesn't exist in this contract";
    if( nBlockTo == "latest" ) {
        const nLatestBlockNumber = owaspUtils.toBN( await safe_getBlockNumber( details, 10, ethersProvider ) );
        nBlockTo = nLatestBlockNumber;
    } else
        nBlockTo = owaspUtils.toBN( nBlockTo );
    nBlockFrom = owaspUtils.toBN( nBlockFrom );
    try {
        // TO-IMPROVE: this must be re-checked
        details.write(
            cc.debug( "First time, will query filter " ) + cc.j( joFilter ) +
            cc.debug( " on contract " ) + cc.info( joContract.address ) +
            cc.debug( " from block " ) + cc.info( nBlockFrom.toHexString() ) +
            cc.debug( " to block " ) + cc.info( nBlockTo.toHexString() ) +
            "\n" );
        ret =
            await joContract.queryFilter(
                joFilter,
                nBlockFrom.toHexString(),
                nBlockTo.toHexString()
                );
        return ret;
    } catch ( err ) {
        ret = retValOnFail;
        details.write(
            cc.error( "Failed filtering attempt " ) + cc.info( idxAttempt ) +
            cc.error( " for event " ) + cc.note( strEventName ) +
            cc.error( " via " ) + cc.u( u ) +
            cc.error( ", from block " ) + cc.warning( nBlockFrom.toHexString() ) + cc.error( ", to block " ) + cc.warning( nBlockTo.toHexString() ) +
            cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
            "\n" );
        if( owaspUtils.extract_error_message( err ).indexOf( strErrorTextAboutNotExistingEvent ) >= 0 ) {
            details.write(
                cc.error( "Did stopped filtering of " ) + cc.note( strEventName ) +
                cc.error( " event because no such event exist in smart contract " ) +
                "\n" );
            return ret;
        }
    }
    ++ idxAttempt;
    while( ret === "" && idxAttempt <= cntAttempts ) {
        const isOnLine = rpcCall.check_url( u, nWaitStepMilliseconds );
        if( ! isOnLine ) {
            ret = retValOnFail;
            if( ! throwIfServerOffline )
                return ret;
            details.write(
                cc.error( "Cannot do " ) + cc.note( strEventName ) + cc.error( " event filtering via " ) + cc.u( u ) +
                cc.warning( " because server is off-line" ) + "\n" );
            throw new Error(
                "Cannot do " + strEventName + " event filtering, from block " +
                nBlockFrom.toHexString() + ", to block " + nBlockTo.toHexString() +
                " via " + u.toString() + " because server is off-line"
            );
        }
        details.write(
            cc.warning( "Repeat " ) + cc.note( strEventName ) +
            cc.error( " event filtering via " ) + cc.u( u ) +
            cc.warning( ", attempt " ) + cc.info( idxAttempt ) +
            "\n" );
        // await sleep( nWaitStepMilliseconds );
        try {
            // TO-IMPROVE: this must be re-checked
            details.write(
                cc.debug( "Attempt ") + cc.info( idxAttempt ) + cc.debug(", will query filter " ) + cc.j( joFilter ) +
                cc.debug( " on contract " ) + cc.info( joContract.address ) +
                cc.debug( " from block " ) + cc.info( nBlockFrom.toHexString() ) +
                cc.debug( " to block " ) + cc.info( nBlockTo.toHexString() ) +
                "\n" );
            ret =
                await joContract.queryFilter(
                    joFilter,
                    nBlockFrom.toHexString(),
                    nBlockTo.toHexString()
                    );
            return ret;

        } catch ( err ) {
            ret = retValOnFail;
            details.write(
                cc.error( "Failed filtering attempt " ) + cc.info( idxAttempt ) +
                cc.error( " for event " ) + cc.note( strEventName ) +
                cc.error( " via " ) + cc.u( u ) +
                cc.error( ", from block " ) + cc.info( nBlockFrom.toHexString() ) + cc.error( ", to block " ) + cc.info( nBlockTo.toHexString() ) +
                cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
                cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                "\n" );
            if( owaspUtils.extract_error_message( err ).indexOf( strErrorTextAboutNotExistingEvent ) >= 0 ) {
                details.write(
                    cc.error( "Did stopped " ) + cc.note( strEventName ) +
                    cc.error( " event filtering because no such event exist in smart contract " ) +
                    "\n" );
                return ret;
            }
        }
        ++ idxAttempt;
    }
    if( ( idxAttempt + 1 ) === cntAttempts && ret === "" ) {
        details.write( cc.fatal( "ERROR:" ) +
            cc.error( " Failed filtering attempt for " ) + cc.note( strEventName ) +
            + cc.error( " event via " ) + cc.u( u ) +
            cc.error( ", from block " ) + cc.info( nBlockFrom.toHexString() ) + cc.error( ", to block " ) + cc.info( nBlockTo.toHexString() ) +
            cc.error( " after " ) + cc.info( cntAttempts ) + cc.error( " attempts " ) +
            "\n" );
        throw new Error(
            "Failed filtering attempt for " + strEventName + " event, from block " + nBlockFrom.toHexString() + ", to block " + nBlockTo.toHexString() +
            " via " + u.toString() + " after " + cntAttempts + " attempts"
        );
    }
    return ret;
}

let g_nCountOfBlocksInIterativeStep = 1000;
let g_nMaxBlockScanIterationsInAllRange = 5000;

export function getBlocksCountInInIterativeStepOfEventsScan() {
    return g_nCountOfBlocksInIterativeStep;
}
export function setBlocksCountInInIterativeStepOfEventsScan( n ) {
    if( ! n )
        g_nCountOfBlocksInIterativeStep = 0;
    else {
        g_nCountOfBlocksInIterativeStep = owaspUtils.parseIntOrHex( n );
        if( g_nCountOfBlocksInIterativeStep < 0 )
            g_nCountOfBlocksInIterativeStep = 0;
    }
}

export function getMaxIterationsInAllRangeEventsScan() {
    return g_nCountOfBlocksInIterativeStep;
}
export function setMaxIterationsInAllRangeEventsScan( n ) {
    if( ! n )
        g_nMaxBlockScanIterationsInAllRange = 0;
    else {
        g_nMaxBlockScanIterationsInAllRange = owaspUtils.parseIntOrHex( n );
        if( g_nMaxBlockScanIterationsInAllRange < 0 )
            g_nMaxBlockScanIterationsInAllRange = 0;
    }
}

export async function safe_getPastEventsIterative( details, ethersProvider, attempts, joContract, strEventName, nBlockFrom, nBlockTo, joFilter ) {
    if( g_nCountOfBlocksInIterativeStep <= 0 || g_nMaxBlockScanIterationsInAllRange <= 0 ) {
        details.write(
            cc.fatal( "IMPORTANT NOTICE:" ) + " " +
            cc.warning( "Will skip " ) + cc.attention( "iterative" ) + cc.warning( " events scan in block range from " ) +
            cc.j( nBlockFrom ) + cc.warning( " to " ) + cc.j( nBlockTo ) +
            cc.warning( " because it's " ) + cc.error( "DISABLED" ) + "\n" );
        return await safe_getPastEvents( details, ethersProvider, attempts, joContract, strEventName, nBlockFrom, nBlockTo, joFilter );
    }
    const nLatestBlockNumber = owaspUtils.toBN( await safe_getBlockNumber( details, 10, ethersProvider ) );
    let isLastLatest = false;
    if( nBlockTo == "latest" ) {
        isLastLatest = true;
        nBlockTo = nLatestBlockNumber;
        details.write(
            cc.debug( "Iterative scan up to latest block " ) +
            cc.attention( "#" ) + cc.info( nBlockTo.toHexString() ) +
            cc.debug( " assumed instead of " ) + cc.attention( "latest" ) + "\n" );
    } else {
        nBlockTo = owaspUtils.toBN( nBlockTo );
        if( nBlockTo.eq( nLatestBlockNumber ) )
            isLastLatest = true;
    }
    nBlockFrom = owaspUtils.toBN( nBlockFrom );
    const nBlockZero = owaspUtils.toBN( 0 );
    const isFirstZero = ( nBlockFrom.eq( nBlockZero ) ) ? true : false;
    if( isFirstZero && isLastLatest ) {
        if( nLatestBlockNumber.div(
                owaspUtils.toBN( g_nCountOfBlocksInIterativeStep )
                ).gt( owaspUtils.toBN( g_nMaxBlockScanIterationsInAllRange ) )
        ) {
            details.write(
                cc.fatal( "IMPORTANT NOTICE:" ) + " " +
                cc.warning( "Will skip " ) + cc.attention( "iterative" ) + cc.warning( " scan and use scan in block range from " ) +
                cc.info( nBlockFrom.toHexString() ) + cc.warning( " to " ) + cc.info( nBlockTo.toHexString() ) + "\n" );
            return await safe_getPastEvents( details, ethersProvider, attempts, joContract, strEventName, nBlockFrom, nBlockTo, joFilter );
        }
    }
    details.write(
        cc.debug( "Iterative scan in " ) +
        cc.info( nBlockFrom.toHexString() ) + cc.debug( "/" ) + cc.info( nBlockTo.toHexString() ) +
        cc.debug( " block range..." ) + "\n" );
    let idxBlockSubRangeFrom = nBlockFrom;
    for( ; true; ) {
        let idxBlockSubRangeTo = idxBlockSubRangeFrom.add( owaspUtils.toBN( g_nCountOfBlocksInIterativeStep ) );
        if( idxBlockSubRangeTo.gt( nBlockTo ) )
            idxBlockSubRangeTo = nBlockTo;
        try {
            details.write(
                cc.debug( "Iterative scan of " ) +
                cc.info( idxBlockSubRangeFrom.toHexString() ) + cc.debug( "/" ) + cc.info( idxBlockSubRangeTo.toHexString() ) +
                cc.debug( " block sub-range in " ) +
                cc.info( nBlockFrom.toHexString() ) + cc.debug( "/" ) + cc.info( nBlockTo.toHexString() ) +
                cc.debug( " block range..." ) + "\n" );
            const joAllEventsInBlock = await safe_getPastEvents( details, ethersProvider, attempts, joContract, strEventName, idxBlockSubRangeFrom, idxBlockSubRangeTo, joFilter );
            if( joAllEventsInBlock && joAllEventsInBlock != "" && joAllEventsInBlock.length > 0 ) {
                details.write(
                    cc.success( "Result of " ) + cc.attention( "iterative" ) + cc.success( " scan in " ) +
                    cc.info( nBlockFrom.toHexString() ) + cc.success( "/" ) + cc.info( nBlockTo.toHexString() ) +
                    cc.success( " block range is " ) + cc.j( joAllEventsInBlock ) + "\n" );
                return joAllEventsInBlock;
            }
        } catch ( err ) {
            details.write(
                cc.error( "Got scan error during interactive scan of " ) +
                cc.info( idxBlockSubRangeFrom.toHexString() ) + cc.error( "/" ) + cc.info( idxBlockSubRangeTo.toHexString() ) +
                cc.error( " block sub-range in " ) + cc.info( nBlockFrom.toHexString() ) + cc.error( "/" ) + cc.info( nBlockTo.toHexString() ) +
                cc.error( " block range, error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
                cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                "\n"
            );
        }
        idxBlockSubRangeFrom = idxBlockSubRangeTo;
        if( idxBlockSubRangeFrom.eq( nBlockTo ) )
            break;
    }
    details.write(
        cc.debug( "Result of " ) + cc.attention( "iterative" ) + cc.debug( " scan in " ) +
        cc.info( nBlockFrom.toHexString() ) + cc.debug( "/" ) + cc.info( nBlockTo.toHexString() ) +
        cc.debug( " block range is " ) + cc.warning( "empty" ) + "\n" );
    return "";
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function verify_transfer_error_category_name( strCategory ) {
    return "" + ( strCategory ? strCategory : "default" );
}

const g_nMaxLastTransferErrors = 20;
const g_arrLastTransferErrors = [];
let g_mapTransferErrorCategories = { };

export const saveTransferEvents = new EventDispatcher();

export function save_transfer_error( strCategory, textLog, ts ) {
    ts = ts || Math.round( ( new Date() ).getTime() / 1000 );
    const c = verify_transfer_error_category_name( strCategory );
    const joTransferEventError = {
        ts: ts,
        category: "" + c,
        textLog: "" + textLog.toString()
    };
    g_arrLastTransferErrors.push( joTransferEventError );
    while( g_arrLastTransferErrors.length > g_nMaxLastTransferErrors )
        g_arrLastTransferErrors.shift();
    g_mapTransferErrorCategories["" + c] = true;
    saveTransferEvents.dispatchEvent( new UniversalDispatcherEvent( "error", { detail: joTransferEventError } ) );
}

export function save_transfer_success( strCategory ) {
    const c = verify_transfer_error_category_name( strCategory );
    try { delete g_mapTransferErrorCategories["" + c]; } catch ( err ) { }
    saveTransferEvents.dispatchEvent( new UniversalDispatcherEvent( "success", { detail: { category: strCategory } } ) );
}

export function save_transfer_success_all() {
    g_mapTransferErrorCategories = { }; // clear all transfer error categories, out of time frame
}

export function get_last_transfer_errors( isIncludeTextLog ) {
    if( typeof isIncludeTextLog == "undefined" )
        isIncludeTextLog = true;
    const jarr = JSON.parse( JSON.stringify( g_arrLastTransferErrors ) );
    if( ! isIncludeTextLog ) {
        for( let i = 0; i < jarr.length; ++ i ) {
            const jo = jarr[i];
            if( "textLog" in jo )
                delete jo.textLog;
        }
    } // if( ! isIncludeTextLog )
    return jarr;
}

export function get_last_error_categories() {
    return Object.keys( g_mapTransferErrorCategories );
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

let g_bIsEnabledProgressiveEventsScan = true;

export function getEnabledProgressiveEventsScan() {
    return g_bIsEnabledProgressiveEventsScan ? true : false;
}
export function setEnabledProgressiveEventsScan( isEnabled ) {
    g_bIsEnabledProgressiveEventsScan = isEnabled ? true : false;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

let g_bIsEnabledOracle = false;

export function getEnabledOracle( isEnabled ) {
    return g_bIsEnabledOracle ? true : false;
}

export function setEnabledOracle( isEnabled ) {
    g_bIsEnabledOracle = isEnabled ? true : false;
}

export async function do_oracle_gas_price_setup(
    ethersProvider_main_net,
    ethersProvider_s_chain,
    tc_s_chain,
    jo_community_locker,
    joAccountSC,
    chain_id_mainnet,
    chain_id_schain,
    fn_sign_o_msg
) {
    if( ! getEnabledOracle() )
        return;
    const details = log.createMemoryStream();
    const jarrReceipts = [];
    const strLogPrefix = cc.info( "Oracle gas price setup:" ) + " ";
    if( fn_sign_o_msg == null || fn_sign_o_msg == undefined ) {
        details.write( strLogPrefix + cc.debug( "Using internal u256 signing stub function" ) + "\n" );
        fn_sign_o_msg = async function( u256, details, fnAfter ) {
            details.write( strLogPrefix + cc.debug( "u256 signing callback was " ) + cc.error( "not provided" ) + "\n" );
            await fnAfter( null, u256, null ); // null - no error, null - no signatures
        };
    } else
        details.write( strLogPrefix + cc.debug( "Using externally provided u256 signing function" ) + "\n" );
    let strActionName = "";
    try {
        strActionName = "do_oracle_gas_price_setup.latestBlockNumber()";
        const latestBlockNumber = await ethersProvider_main_net.getBlockNumber();
        details.write( cc.debug( "Latest block on Main Net is " ) + cc.info( latestBlockNumber ) + "\n" );
        strActionName = "do_oracle_gas_price_setup.bnTimestampOfBlock()";
        const latestBlock = await ethersProvider_main_net.getBlock( latestBlockNumber );
        let bnTimestampOfBlock = owaspUtils.toBN( latestBlock.timestamp );
        details.write(
            cc.debug( "Local timestamp on Main Net is " ) + cc.info( bnTimestampOfBlock.toString() ) + cc.debug( "=" ) +
            cc.info( owaspUtils.ensure_starts_with_0x( bnTimestampOfBlock.toString( 16 ) ) ) + cc.debug( " (original)" ) +
            "\n" );
        const bnTimeZoneOffset = owaspUtils.toBN( parseInt( new Date( parseInt( bnTimestampOfBlock.toString(), 10 ) ).getTimezoneOffset(), 10 ) );
        details.write(
            cc.debug( "Local time zone offset is " ) + cc.info( bnTimeZoneOffset.toString() ) + cc.debug( "=" ) +
            cc.info( owaspUtils.ensure_starts_with_0x( bnTimeZoneOffset.toString( 16 ) ) ) + cc.debug( " (original)" ) +
            "\n" );
        bnTimestampOfBlock = bnTimestampOfBlock.add( bnTimeZoneOffset );
        details.write(
            cc.debug( "UTC timestamp on Main Net is " ) + cc.info( bnTimestampOfBlock.toString() ) + cc.debug( "=" ) +
            cc.info( owaspUtils.ensure_starts_with_0x( bnTimestampOfBlock.toString( 16 ) ) ) + cc.debug( " (original)" ) +
            "\n" );
        const bnValueToSubtractFromTimestamp = owaspUtils.toBN( 60 );
        details.write(
            cc.debug( "Value to subtract from timestamp is " ) + cc.info( bnValueToSubtractFromTimestamp ) + cc.debug( "=" ) +
            cc.info( owaspUtils.ensure_starts_with_0x( bnValueToSubtractFromTimestamp.toString( 16 ) ) ) + cc.debug( " (to adjust it to past a bit)" ) + "\n" );
        bnTimestampOfBlock = bnTimestampOfBlock.sub( bnValueToSubtractFromTimestamp );
        details.write(
            cc.debug( "Timestamp on Main Net is " ) + cc.info( bnTimestampOfBlock.toString() ) + cc.debug( "=" ) +
            cc.info( owaspUtils.ensure_starts_with_0x( bnTimestampOfBlock.toString( 16 ) ) ) + cc.debug( " (adjusted to past a bit)" ) +
            "\n" );
        strActionName = "do_oracle_gas_price_setup.getGasPrice()";
        let gasPriceOnMainNet = null;
        if( IMA.getEnabledOracle() ) {
            const oracleOpts = {
                url: owaspUtils.ep_2_url( ethersProvider_s_chain ),
                callOpts: { },
                nMillisecondsSleepBefore: 1000,
                nMillisecondsSleepPeriod: 3000,
                cntAttempts: 40,
                isVerbose: ( verbose_get() >= RV_VERBOSE().information ) ? true : false,
                isVerboseTraceDetails: ( verbose_get() >= RV_VERBOSE().debug ) ? true : false
            };
            details.write(
                cc.debug( "Will fetch " ) + cc.info( "Main Net gas price" ) +
                cc.debug( " via call to " ) + cc.info( "Oracle" ) +
                cc.debug( " with options " ) + cc.j( oracleOpts ) +
                cc.debug( "..." ) + "\n" );
            try {
                gasPriceOnMainNet = owaspUtils.ensure_starts_with_0x( ( await imaOracle.get_gas_price( oracleOpts, details ) ).toString( 16 ) );
            } catch ( err ) {
                gasPriceOnMainNet = null;
                details.write(
                    cc.error( "Failed to fetch " ) + cc.info( "Main Net gas price" ) +
                    cc.error( " via call to " ) + cc.info( "Oracle" ) +
                    cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
                    cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                    "\n" );
            }
        }
        if( gasPriceOnMainNet === null ) {
            details.write(
                cc.debug( "Will fetch " ) + cc.info( "Main Net gas price" ) +
                cc.debug( " directly..." ) + "\n" );
            gasPriceOnMainNet = owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( await ethersProvider_main_net.getGasPrice() ).toHexString() );
        }
        details.write(
            cc.success( "Done, " ) + cc.info( "Oracle" ) + cc.success( " did computed new " ) + cc.info( "Main Net gas price" ) +
            cc.success( "=" ) + cc.bright( owaspUtils.toBN( gasPriceOnMainNet ).toString() ) +
            cc.success( "=" ) + cc.bright( gasPriceOnMainNet ) +
            "\n" );

        const joGasPriceOnMainNetOld =
            await jo_community_locker.callStatic.mainnetGasPrice( {
                from: joAccountSC.address()
            } );
        const bnGasPriceOnMainNetOld = owaspUtils.toBN( joGasPriceOnMainNetOld );
        details.write(
            cc.debug( "Previous " ) + cc.info( "Main Net gas price" ) + cc.debug( " saved and kept in " ) + cc.info( "CommunityLocker" ) +
            cc.debug( "=" ) + cc.bright( bnGasPriceOnMainNetOld.toString() ) +
            cc.debug( "=" ) + cc.bright( bnGasPriceOnMainNetOld.toString( 16 ) ) +
            "\n" );
        if( bnGasPriceOnMainNetOld.eq( owaspUtils.toBN( gasPriceOnMainNet ) ) ) {
            details.write(
                cc.debug( "Previous " ) + cc.info( "Main Net gas price" ) +
                cc.debug( " is equal to new one, will skip setting it in " ) + cc.info( "CommunityLocker" ) +
                "\n" );
            if( expose_details_get() )
                details.exposeDetailsTo( log, "do_oracle_gas_price_setup", true );
            details.close();
            return;
        }

        strActionName = "do_oracle_gas_price_setup.fn_sign_o_msg()";
        await fn_sign_o_msg( gasPriceOnMainNet, details, async function( strError, u256, joGlueResult ) {
            if( strError ) {
                if( verbose_get() >= RV_VERBOSE().fatal )
                    log.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in do_oracle_gas_price_setup() during " + strActionName + ": " ) + cc.error( strError ) + "\n" );
                details.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in do_oracle_gas_price_setup() during " + strActionName + ": " ) + cc.error( strError ) + "\n" );
                details.exposeDetailsTo( log, "do_oracle_gas_price_setup", false );
                save_transfer_error( "oracle", details.toString() );
                details.close();
                return;
            }

            strActionName = "do_oracle_gas_price_setup.formatSignature";
            let signature = joGlueResult ? joGlueResult.signature : null;
            if( !signature )
                signature = { X: "0", Y: "0" };
            let hashPoint = joGlueResult ? joGlueResult.hashPoint : null;
            if( !hashPoint )
                hashPoint = { X: "0", Y: "0" };
            let hint = joGlueResult ? joGlueResult.hint : null;
            if( !hint )
                hint = "0";
            const sign = {
                blsSignature: [ signature.X, signature.Y ], // BLS glue of signatures
                hashA: hashPoint.X, // G1.X from joGlueResult.hashSrc
                hashB: hashPoint.Y, // G1.Y from joGlueResult.hashSrc
                counter: hint
            };
            strActionName = "Oracle gas price setup via CommunityLocker.setGasPrice()";
            const arrArguments_setGasPrice = [
                u256,
                owaspUtils.ensure_starts_with_0x( bnTimestampOfBlock.toString( 16 ) ),
                sign // bls signature components
            ];
            if( verbose_get() >= RV_VERBOSE().debug ) {
                const joDebugArgs = [
                    [ signature.X, signature.Y ], // BLS glue of signatures
                    hashPoint.X, // G1.X from joGlueResult.hashSrc
                    hashPoint.Y, // G1.Y from joGlueResult.hashSrc
                    hint
                ];
                details.write(
                    strLogPrefix +
                    cc.debug( "....debug args for " ) + cc.debug( ": " ) +
                    cc.j( joDebugArgs ) + "\n" );
            }
            const weiHowMuch = undefined;
            const gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
            details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
            const estimatedGas_setGasPrice =
                await tc_s_chain.computeGas(
                    details,
                    ethersProvider_s_chain,
                    "CommunityLocker", jo_community_locker, "setGasPrice", arrArguments_setGasPrice,
                    joAccountSC, strActionName,
                    gasPrice, 10000000, weiHowMuch,
                    null
                );
            details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_setGasPrice ) + "\n" );
            const isIgnore_setGasPrice = false;
            const strErrorOfDryRun =
                await dry_run_call(
                    details,
                    ethersProvider_s_chain,
                    "CommunityLocker", jo_community_locker, "setGasPrice", arrArguments_setGasPrice,
                    joAccountSC, strActionName, isIgnore_setGasPrice,
                    gasPrice, estimatedGas_setGasPrice, weiHowMuch,
                    null
                );
            if( strErrorOfDryRun )
                throw new Error( strErrorOfDryRun );

            let opts = {
                isCheckTransactionToSchain: ( chain_id_schain !== "Mainnet" ) ? true : false
            };
            const joReceipt =
                await payed_call(
                    details,
                    ethersProvider_s_chain,
                    "CommunityLocker", jo_community_locker, "setGasPrice", arrArguments_setGasPrice,
                    joAccountSC, strActionName,
                    gasPrice, estimatedGas_setGasPrice, weiHowMuch,
                    opts
                );
            if( joReceipt && typeof joReceipt == "object" ) {
                jarrReceipts.push( {
                    "description": "do_oracle_gas_price_setup/setGasPrice",
                    "receipt": joReceipt
                } );
                print_gas_usage_report_from_array( "(intermediate result) ORACLE GAS PRICE SETUP ", jarrReceipts );
            }

            save_transfer_success( "oracle" );
        } );
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in do_oracle_gas_price_setup() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +"\n" );
        details.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in do_oracle_gas_price_setup() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +"\n" );
        details.exposeDetailsTo( log, "do_oracle_gas_price_setup", false );
        save_transfer_error( "oracle", details.toString() );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ORACLE GAS PRICE SETUP ", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_oracle_gas_price_setup", true );
    details.close();
    return true;
}

let g_isForwardS2S = true; // default S<->S transfer mode for "--s2s-transfer" is "forward"

export function get_S2S_transfer_mode_description() {
    return g_isForwardS2S ? "forward" : "reverse";
}

export function get_S2S_transfer_mode_description_colorized() {
    return g_isForwardS2S ? cc.success( "forward" ) : cc.error( "reverse" );
}

export function isForwardS2S() {
    return g_isForwardS2S ? true : false;
}

export function isReverseS2S() {
    return g_isForwardS2S ? false : true;
}

export function setForwardS2S( b ) {
    if( b == null || b == undefined )
        b = true;
    g_isForwardS2S = b ? true : false;
}

export function setReverseS2S( b ) {
    if( b == null || b == undefined )
        b = true;
    g_isForwardS2S = b ? false : true;
}

export function create_progressive_events_scan_plan( details, nLatestBlockNumber ) {
    // assume Main Net mines 6 blocks per minute
    const blocks_in_1_minute = 6;
    const blocks_in_1_hour = blocks_in_1_minute * 60;
    const blocks_in_1_day = blocks_in_1_hour * 24;
    const blocks_in_1_week = blocks_in_1_day * 7;
    const blocks_in_1_month = blocks_in_1_day * 31;
    const blocks_in_1_year = blocks_in_1_day * 366;
    const blocks_in_3_years = blocks_in_1_year * 3;
    const arr_progressive_events_scan_plan_A = [
        { nBlockFrom: nLatestBlockNumber - blocks_in_1_day, nBlockTo: "latest", type: "1 day" },
        { nBlockFrom: nLatestBlockNumber - blocks_in_1_week, nBlockTo: "latest", type: "1 week" },
        { nBlockFrom: nLatestBlockNumber - blocks_in_1_month, nBlockTo: "latest", type: "1 month" },
        { nBlockFrom: nLatestBlockNumber - blocks_in_1_year, nBlockTo: "latest", type: "1 year" },
        { nBlockFrom: nLatestBlockNumber - blocks_in_3_years, nBlockTo: "latest", type: "3 years" }
    ];
    const arr_progressive_events_scan_plan = [];
    for( let idxPlan = 0; idxPlan < arr_progressive_events_scan_plan_A.length; ++idxPlan ) {
        const joPlan = arr_progressive_events_scan_plan_A[idxPlan];
        if( joPlan.nBlockFrom >= 0 )
            arr_progressive_events_scan_plan.push( joPlan );
    }
    if( arr_progressive_events_scan_plan.length > 0 ) {
        const joLastPlan = arr_progressive_events_scan_plan[arr_progressive_events_scan_plan.length - 1];
        if( ! ( joLastPlan.nBlockFrom == 0 && joLastPlan.nBlockTo == "latest" ) )
            arr_progressive_events_scan_plan.push( { nBlockFrom: 0, nBlockTo: "latest", type: "entire block range" } );
    } else
        arr_progressive_events_scan_plan.push( { nBlockFrom: 0, nBlockTo: "latest", type: "entire block range" } );
    return arr_progressive_events_scan_plan;
}

export async function safe_getPastEventsProgressive( details, ethersProvider, attempts, joContract, strEventName, nBlockFrom, nBlockTo, joFilter ) {
    if( ! g_bIsEnabledProgressiveEventsScan ) {
        details.write(
            cc.fatal( "IMPORTANT NOTICE:" ) + " " +
            cc.warning( "Will skip " ) + cc.attention( "progressive" ) + cc.warning( " events scan in block range from " ) +
            cc.j( nBlockFrom ) + cc.warning( " to " ) + cc.j( nBlockTo ) +
            cc.warning( " because it's " ) + cc.error( "DISABLED" ) + "\n" );
        return await safe_getPastEvents( details, ethersProvider, attempts, joContract, strEventName, nBlockFrom, nBlockTo, joFilter );
    }
    const nLatestBlockNumber = owaspUtils.toBN( await safe_getBlockNumber( details, 10, ethersProvider ) );
    let isLastLatest = false;
    if( nBlockTo == "latest" ) {
        isLastLatest = true;
        nBlockTo = nLatestBlockNumber;
        details.write(
            cc.debug( "Iterative scan up to latest block " ) +
            cc.attention( "#" ) + cc.info( nBlockTo.toHexString() ) +
            cc.debug( " assumed instead of " ) + cc.attention( "latest" ) + "\n" );
    } else {
        nBlockTo = owaspUtils.toBN( nBlockTo );
        if( nBlockTo.eq( nLatestBlockNumber ) )
            isLastLatest = true;
    }
    nBlockFrom = owaspUtils.toBN( nBlockFrom );
    const nBlockZero = owaspUtils.toBN( 0 );
    const isFirstZero = ( nBlockFrom.eq( nBlockZero ) ) ? true : false;
    if( ! ( isFirstZero && isLastLatest ) ) {
        details.write(
            cc.debug( "Will skip " ) + cc.attention( "progressive" ) + cc.debug( " scan and use scan in block range from " ) +
            cc.info( nBlockFrom.toHexString() ) + cc.debug( " to " ) + cc.info( nBlockTo.toHexString() ) + "\n" );
        return await safe_getPastEvents( details, ethersProvider, attempts, joContract, strEventName, nBlockFrom, nBlockTo, joFilter );
    }
    details.write( cc.debug( "Will run " ) + cc.attention( "progressive" ) + cc.debug( " scan..." ) + "\n" );
    details.write( cc.debug( "Current latest block number is " ) + cc.info( nLatestBlockNumber.toHexString() ) + "\n" );
    const arr_progressive_events_scan_plan = create_progressive_events_scan_plan( details, nLatestBlockNumber );
    details.write( cc.debug( "Composed " ) + cc.attention( "progressive" ) + cc.debug( " scan plan is: " ) + cc.j( arr_progressive_events_scan_plan ) + "\n" );
    let joLastPlan = { nBlockFrom: 0, nBlockTo: "latest", type: "entire block range" };
    for( let idxPlan = 0; idxPlan < arr_progressive_events_scan_plan.length; ++idxPlan ) {
        const joPlan = arr_progressive_events_scan_plan[idxPlan];
        if( joPlan.nBlockFrom < 0 )
            continue;
        joLastPlan = joPlan;
        details.write(
            cc.debug( "Progressive scan of " ) + cc.attention( "getPastEvents" ) + cc.debug( "/" ) + cc.info( strEventName ) +
            cc.debug( ", from block " ) + cc.info( joPlan.nBlockFrom ) +
            cc.debug( ", to block " ) + cc.info( joPlan.nBlockTo ) +
            cc.debug( ", block range is " ) + cc.info( joPlan.type ) +
            cc.debug( "..." ) + "\n" );
        try {
            const joAllEventsInBlock =
                await safe_getPastEventsIterative(
                    details, ethersProvider, attempts, joContract,
                    strEventName,
                    joPlan.nBlockFrom, joPlan.nBlockTo,
                    joFilter
                    );
            if( joAllEventsInBlock && joAllEventsInBlock.length > 0 ) {
                details.write(
                    cc.success( "Progressive scan of " ) + cc.attention( "getPastEvents" ) + cc.debug( "/" ) + cc.info( strEventName ) +
                    cc.success( ", from block " ) + cc.info( joPlan.nBlockFrom ) +
                    cc.success( ", to block " ) + cc.info( joPlan.nBlockTo ) +
                    cc.success( ", block range is " ) + cc.info( joPlan.type ) +
                    cc.success( ", found " ) + cc.info( joAllEventsInBlock.length ) +
                    cc.success( " event(s)" ) + "\n" );
                return joAllEventsInBlock;
            }
        } catch ( err ) {}
    }
    // throw new Error(
    //     "Could not not get Event \"" + strEventName +
    //     "\", from block " + joLastPlan.nBlockFrom + ", to block " + joLastPlan.nBlockTo +
    //     ", using progressive event scan"
    // );
    details.write(
        cc.error( "Could not not get Event \"" ) + cc.info( strEventName ) +
        cc.error( "\", from block " ) + cc.info( joLastPlan.nBlockFrom ) +
        cc.error( ", to block " ) + cc.info( joLastPlan.nBlockTo ) +
        cc.debug( ", block range is " ) + cc.info( joLastPlan.type ) +
        cc.error( ", using " ) + cc.attention( "progressive" ) + cc.error( " event scan" ) + "\n" );
    return [];
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function get_contract_call_events( details, ethersProvider, joContract, strEventName, nBlockNumber, strTxHash, joFilter ) {
    joFilter = joFilter || {};
    nBlockNumber = owaspUtils.toBN( nBlockNumber );
    let n10 = owaspUtils.toBN( 10 );
    let nBlockFrom = nBlockNumber.sub( n10 ), nBlockTo = nBlockNumber.add( n10 );
    const nBlockZero = owaspUtils.toBN( 0 );
    const nLatestBlockNumber = owaspUtils.toBN( await safe_getBlockNumber( details, 10, ethersProvider ) );
    if( nBlockFrom.lt( nBlockZero ) )
        nBlockFrom = nBlockZero;
    if( nBlockTo.gt( nLatestBlockNumber ) )
        nBlockTo = nLatestBlockNumber;
    const joAllEventsInBlock =
        await safe_getPastEventsIterative(
            details, ethersProvider, 10, joContract,
            strEventName,
            nBlockFrom, nBlockTo,
            joFilter
            );
    const joAllTransactionEvents = []; let i;
    for( i = 0; i < joAllEventsInBlock.length; ++i ) {
        const joEvent = joAllEventsInBlock[i];
        if( "transactionHash" in joEvent && joEvent.transactionHash == strTxHash )
            joAllTransactionEvents.push( joEvent );
    }
    return joAllTransactionEvents;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function compose_tx_instance( details, strLogPrefix, rawTx ) {
    details.write( cc.attention( "TRANSACTION COMPOSER" ) + cc.normal( " is using " ) + cc.bright( "Web3" ) + cc.normal( " version " ) + cc.sunny( w3mod.version ) + "\n" );
    strLogPrefix = strLogPrefix || "";
    rawTx = JSON.parse( JSON.stringify( rawTx ) ); // clone
    const joOpts = null;
    details.write( strLogPrefix + cc.debug( "....composed " ) + cc.notice( JSON.stringify( rawTx ) ) + cc.debug( " with opts " ) + cc.j( joOpts ) + "\n" );
    let tx = null;
    if( joOpts )
        tx = new ethereumjs_tx( rawTx, joOpts );
    else
        tx = new ethereumjs_tx( rawTx );
    return tx;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

let g_bDryRunIsEnabled = true;

export function dry_run_is_enabled() {
    return g_bDryRunIsEnabled ? true : false;
}

export function dry_run_enable( isEnable ) {
    g_bDryRunIsEnabled = ( isEnable != null && isEnable != undefined ) ? ( isEnable ? true : false ) : true;
    return g_bDryRunIsEnabled ? true : false;
}

let g_bDryRunIsIgnored = false;

export function dry_run_is_ignored() {
    return g_bDryRunIsIgnored ? true : false;
}

export function dry_run_ignore( isIgnored ) {
    g_bDryRunIsIgnored = ( isIgnored != null && isIgnored != undefined ) ? ( isIgnored ? true : false ) : true;
    return g_bDryRunIsIgnored ? true : false;
}

export async function dry_run_call(
    details,
    ethersProvider,
    strContractName, joContract, strMethodName, arrArguments,
    joAccount, strActionName, isDryRunResultIgnore,
    gasPrice, gasValue, weiHowMuch,
    opts
) {
    isDryRunResultIgnore = ( isDryRunResultIgnore != null && isDryRunResultIgnore != undefined ) ? ( isDryRunResultIgnore ? true : false ) : false;
    const strContractMethodDescription = cc.notice( strContractName ) + cc.debug( "(" ) + cc.info( joContract.address ) + cc.debug( ")." ) + cc.notice( strMethodName );
    let strArgumentsDescription = "";
    if( arrArguments.length > 0 ) {
        strArgumentsDescription += cc.debug( "( " );
        for( let i = 0; i < arrArguments.length; ++ i ) {
            if( i > 0 )
                strArgumentsDescription += cc.debug( ", " );
            strArgumentsDescription += cc.j( arrArguments[i] );
        }
        strArgumentsDescription += cc.debug( " )" );
    } else
        strArgumentsDescription += cc.debug( "()" );
    const strContractCallDescription = strContractMethodDescription + strArgumentsDescription;
    const strLogPrefix = strContractMethodDescription + " ";
    try {
        details.write( cc.debug( "Dry-run of action " ) + cc.info( strActionName ) + cc.debug( "..." ) + "\n" );
        details.write( cc.debug( "Will dry-run " ) + strContractCallDescription + cc.debug( "..." ) + "\n" );
        const strAccountWalletAddress = joAccount.address();
        const callOpts = {
            from: strAccountWalletAddress
        };
        if( gasPrice )
            callOpts.gasPrice = owaspUtils.toBN( gasPrice ).toHexString();
        if( gasValue )
            callOpts.gasLimit = owaspUtils.toBN( gasValue ).toHexString();
        if( weiHowMuch )
            callOpts.value = owaspUtils.toBN( weiHowMuch ).toHexString();
        const joDryRunResult = await joContract.callStatic[strMethodName]( ...arrArguments, callOpts );
        details.write( strLogPrefix + cc.success( "dry-run success: " ) + cc.j( joDryRunResult ) + "\n" );
        return null; // success
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        details.write( strLogPrefix + cc.error( "dry-run error: " ) + cc.warning( strError ) + "\n" );
        return strError;
    }
}

export async function payed_call(
    details,
    ethersProvider,
    strContractName, joContract, strMethodName, arrArguments,
    joAccount, strActionName,
    gasPrice, estimatedGas, weiHowMuch,
    opts
) {
    const strContractMethodDescription = cc.notice( strContractName ) + cc.debug( "(" ) + cc.info( joContract.address ) + cc.debug( ")." ) + cc.info( strMethodName );
    let strArgumentsDescription = "";
    if( arrArguments.length > 0 ) {
        strArgumentsDescription += cc.debug( "( " );
        for( let i = 0; i < arrArguments.length; ++ i ) {
            if( i > 0 )
                strArgumentsDescription += cc.debug( ", " );
            strArgumentsDescription += cc.j( arrArguments[i] );
        }
        strArgumentsDescription += cc.debug( " )" );
    } else
        strArgumentsDescription += cc.debug( "()" );
    const strContractCallDescription = strContractMethodDescription + strArgumentsDescription;
    const strLogPrefix = strContractMethodDescription + " ";
    try {
        const ethersWallet = new owaspUtils.ethersMod.ethers.Wallet( owaspUtils.ensure_starts_with_0x( joAccount.privateKey ), ethersProvider );
        const callOpts = {
        };
        if( gasPrice )
            callOpts.gasPrice = owaspUtils.toBN( gasPrice ).toHexString();
        if( estimatedGas )
            callOpts.gasLimit = owaspUtils.toBN( estimatedGas ).toHexString();
        if( weiHowMuch )
            callOpts.value = owaspUtils.toBN( weiHowMuch ).toHexString();
        details.write( cc.debug( "Payed-call of action " ) + cc.info( strActionName ) + cc.debug( "..." ) + "\n" );
        details.write( strLogPrefix + cc.debug( "Will do payed-call " ) + strContractCallDescription + cc.debug( "..." ) + "\n" );
        const txx = await joContract.populateTransaction[strMethodName]( ...arrArguments, callOpts );
        details.write( strLogPrefix + cc.debug( "raw transaction: " ) + cc.j( txx ) + "\n" );
        // if( opts && opts.isCheckTransactionToSchain ) {
        //     txx = await checkTransactionToSchain( txx, details, ethersProvider );
        //     details.write( strLogPrefix + cc.debug( "raw transaction, checked for S-chain: " ) + cc.j( txx ) + "\n" );
        // }
        let joSent = await ethersWallet.sendTransaction( txx );
        details.write( strLogPrefix + cc.debug( "transaction sent: " ) + cc.j( joSent ) + "\n" );
        let joReceipt = await joSent.wait();
        details.write( strLogPrefix + cc.debug( "transaction receipt:" ) + cc.j( joReceipt ) + "\n" );
        const bnGasSpent = owaspUtils.toBN( joReceipt.cumulativeGasUsed );
        const gasSpent = bnGasSpent.toString();
        const ethSpent = owaspUtils.ethersMod.ethers.utils.formatEther( joReceipt.cumulativeGasUsed.mul( txx.gasPrice ) );
        joReceipt.summary = {
            bnGasSpent: bnGasSpent,
            gasSpent: gasSpent,
            ethSpent: ethSpent
        };
        details.write( strLogPrefix + cc.debug( "gas spent: " ) + cc.info( gasSpent ) + "\n" );
        details.write( strLogPrefix + cc.debug( "ETH spent: " ) + cc.info( ethSpent ) + "\n" );
        return joReceipt;
    } catch ( err ) {
        details.write(
            strLogPrefix + cc.error( "payed call error: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
            "\n" );
        return new Error(
            "CRITICAL CONTRACT METHOD CALL FAIL: Invoking the " + strContractCallDescription +
            " method: " + owaspUtils.extract_error_message( err )
        );
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function checkTransactionToSchain(
    txx,
    details,
    ethersProvider
    ) {
    const sender = txx.from;
    const requiredBalance = txx.gasPrice.mul( txx.gasLimit );
    const balance = owaspUtils.toBN( await ethersProvider.getBalance( sender ) );
    if( balance.lt( requiredBalance ) ) {
        details.write(
            cc.warning( "Insufficient funds for " ) + cc.bright( sender ) +
            cc.warning( "; Will run " ) + cc.sunny( "PoW" ) + cc.warning( " for mining " ) +
            cc.bright( txx.gasLimit.toHexString() ) + cc.warning( " gas" ) +
            "\n" );
        const powNumber = await calculatePowNumber( sender, txx.nonce.toString(), txx.gasLimit.toString(), details );
        details.write(
            cc.warning( "Done, " ) + cc.sunny( "PoW" ) +
            cc.warning( " number is " ) + cc.bright( powNumber ) +
            "\n" );
        txx.gasPrice = owaspUtils.toBN( owaspUtils.ensure_starts_with_0x( powNumber ) );
    }
    return txx;
}

export async function calculatePowNumber( address, nonce, gas, details ) {
    try {
        let _address = owaspUtils.ensure_starts_with_0x( address );
        _address = ethereumjs_util.toChecksumAddress( _address );
        _address = owaspUtils.remove_starting_0x( _address );
        const _nonce = owaspUtils.parseIntOrHex( nonce );
        const _gas = owaspUtils.parseIntOrHex( gas );
        const powScriptPath = path.join( __dirname, "pow" );
        const cmd = `${powScriptPath} ${_address} ${_nonce} ${_gas}`;
        return await execShellCommand( cmd );
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal ) {
            details.write(
                cc.fatal( "CRITICAL POW ERROR:" ) + " " +
                cc.error( "exception occur during PoW, error information is:" ) + " " + cc.error( strError ) +
                cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                "\n" );
        }
        return 0;
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function get_account_connectivity_info( joAccount ) {
    const joACI = {
        isBad: true,
        strType: "bad",
        isAutoSend: false
    };
    if( "strTransactionManagerURL" in joAccount && typeof joAccount.strTransactionManagerURL == "string" && joAccount.strTransactionManagerURL.length > 0 ) {
        joACI.isBad = false;
        joACI.strType = "tm";
        joACI.isAutoSend = true;
    } else if( "strSgxURL" in joAccount && typeof joAccount.strSgxURL == "string" && joAccount.strSgxURL.length > 0 &&
        "strSgxKeyName" in joAccount && typeof joAccount.strSgxKeyName == "string" && joAccount.strSgxKeyName.length > 0
    ) {
        joACI.isBad = false;
        joACI.strType = "sgx";
    } else if( "privateKey" in joAccount && typeof joAccount.privateKey == "string" && joAccount.privateKey.length > 0 ) {
        joACI.isBad = false;
        joACI.strType = "direct";
    } else {
        // bad by default
    }
    return joACI;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const g_tm_pool = "transactions";

const tm_gen_random_hex = size => [ ...Array( size ) ].map( () => Math.floor( Math.random() * 16 ).toString( 16 ) ).join( "" );

function tm_make_id( details ) {
    const prefix = "tx-";
    const unique = tm_gen_random_hex( 16 );
    const id = prefix + unique + "js";
    details.write( cc.debug( "TM - Generated id: " ) + cc.debug( id ) + "\n" );
    return id;
}

function tm_make_record( tx = {}, score ) {
    const status = "PROPOSED";
    return JSON.stringify( {
        "score": score,
        "status": status,
        ...tx
    } );
}

function tm_make_score( priority ) {
    const ts = current_timestamp();
    return priority * Math.pow( 10, ts.toString().length ) + ts;
}

async function tm_send( details, tx, priority = 5 ) {
    details.write( cc.debug( "TM - sending tx " ) + cc.j( tx ) +
        cc.debug( " ts: " ) + cc.info( current_timestamp() ) + "\n" );
    const id = tm_make_id( details );
    const score = tm_make_score( priority );
    const record = tm_make_record( tx, score );
    details.write( cc.debug( "TM - Sending score: " ) + cc.info( score ) + cc.debug( ", record: " ) + cc.info( record ) + "\n" );
    expiration = 24 * 60 * 60; // 1 day;

    await redis.multi()
        .set( id, record, "EX", expiration )
        .zadd( g_tm_pool, score, id )
        .exec();
    return id;
}

function tm_is_finished( record ) {
    if( record == null )
        return null;
    return [ "SUCCESS", "FAILED", "DROPPED" ].includes( record.status );
}

async function tm_get_record( txId ) {
    const r = await redis.get( txId );
    if( r != null )
        return JSON.parse( r );
    return null;
}

async function tm_wait( details, txId, w3, nWaitSeconds = 36000 ) {
    const strPrefixDetails = cc.debug( "(gathered details)" ) + " ";
    const strPrefixLog = cc.debug( "(immediate log)" ) + " ";
    let strMsg =
        cc.debug( "TM - will wait TX " ) + cc.info( txId ) +
        cc.debug( " to complete for " ) + cc.info( nWaitSeconds ) + cc.debug( " second(s) maximum" );
    details.write( strPrefixDetails + strMsg + "\n" );
    log.write( strPrefixLog + strMsg + "\n" );
    const startTs = current_timestamp();
    while( ! tm_is_finished( await tm_get_record( txId ) ) && ( current_timestamp() - startTs ) < nWaitSeconds )
        await sleep( 500 );
    const r = await tm_get_record( txId );
    strMsg = cc.debug( "TM - TX " ) + cc.info( txId ) + cc.debug( " record is " ) + cc.info( JSON.stringify( r ) );
    details.write( strPrefixDetails + strMsg + "\n" );
    log.write( strPrefixLog + strMsg + "\n" );
    if( ( !r ) ) {
        strMsg = cc.error( "TM - TX " ) + cc.info( txId ) + cc.error( " status is " ) + cc.warning( "NULL RECORD" );
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
    } else if( r.status == "SUCCESS" ) {
        strMsg = cc.success( "TM - TX " ) + cc.info( txId ) + cc.success( " success" );
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
    } else {
        strMsg = cc.error( "TM - TX " ) + cc.info( txId ) + cc.error( " status is " ) + cc.warning( r.status );
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
    }
    if( ( !tm_is_finished( r ) ) || r.status == "DROPPED" ) {
        log.write( cc.error( "TM - TX " ) + cc.info( txId ) + cc.error( " was unsuccessful, wait failed" ) + "\n" );
        return null;
    }
    const joReceipt = await safe_getTransactionReceipt( details, 10, w3, r.tx_hash );
    if( !joReceipt ) {
        strMsg = cc.error( "TM - TX " ) + cc.info( txId ) + cc.error( " was unsuccessful, failed to fetch transaction receipt" );
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
        return null;
    }
    return joReceipt;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

async function tm_ensure_transaction( details, w3, priority, txAdjusted, cntAttempts, sleepMilliseconds ) {
    cntAttempts = cntAttempts || 1;
    sleepMilliseconds = sleepMilliseconds || ( 30 * 1000 );
    let txId = "";
    let joReceipt = null;
    let idxAttempt = 0;
    const strPrefixDetails = cc.debug( "(gathered details)" ) + " ";
    const strPrefixLog = cc.debug( "(immediate log)" ) + " ";
    let strMsg;
    for( ; idxAttempt < cntAttempts; ++idxAttempt ) {
        txId = await tm_send( details, txAdjusted, priority );
        strMsg = cc.debug( "TM - next TX " ) + cc.info( txId );
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
        joReceipt = await tm_wait( details, txId, w3 );
        if( joReceipt )
            break;
        strMsg =
            cc.warning( "TM - unsuccessful TX " ) + cc.info( txId ) + cc.warning( " sending attempt " ) + cc.info( idxAttempt ) +
            cc.warning( " of " ) + cc.info( cntAttempts ) + cc.debug( " receipt: " ) + cc.info( joReceipt );
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
        await sleep( sleepMilliseconds );
    }
    if( !joReceipt ) {
        strMsg =
            cc.fatal( "BAD ERROR:" ) + " " + cc.error( "TM TX " ) + cc.info( txId ) +
            cc.error( " transaction has been dropped" );
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
        throw new Error( "TM unsuccessful transaction " + txId );
    }
    strMsg =
        cc.success( "TM - successful TX " ) + cc.info( txId ) + cc.success( ", sending attempt " ) + cc.info( idxAttempt ) +
        cc.success( " of " ) + cc.info( cntAttempts );
    details.write( strPrefixDetails + strMsg + "\n" );
    log.write( strPrefixLog + strMsg + "\n" );
    return [ txId, joReceipt ];
}

export async function safe_sign_transaction_with_account( details, w3, tx, rawTx, joAccount ) {
    const strPrefixDetails = cc.debug( "(gathered details)" ) + " ";
    const strPrefixLog = cc.debug( "(immediate log)" ) + " ";
    const sendingCnt = loopTmSendingCnt++;
    let strMsg =
        cc.debug( "Signing(and later, sending) transaction with account(" ) + cc.notice( "sending counter" ) + cc.debug( " is " ) +
        cc.info( sendingCnt ) + cc.debug( "), raw TX object is " ) + cc.j( rawTx );
    details.write( strPrefixDetails + strMsg + "\n" );
    log.write( strPrefixLog + strMsg + "\n" );
    const joSR = {
        joACI: get_account_connectivity_info( joAccount ),
        tx: null,
        txHashSent: null
    };
    strMsg = cc.debug( "Signing(and later, sending) transaction with backend type: " ) + cc.bright( joSR.joACI.strType );
    details.write( strPrefixDetails + strMsg + "\n" );
    log.write( strPrefixLog + strMsg + "\n" );
    switch ( joSR.joACI.strType ) {
    case "tm": {
        /*
        details.write(
            cc.debug( "Will sign with Transaction Manager wallet, transaction is " ) + cc.j( tx ) +
            cc.debug( ", raw transaction is " ) + cc.j( rawTx ) + "\n"
            // + cc.debug( " using account " ) + cc.j( joAccount ) + "\n"
        );
        let rpcCallOpts = null;
        if( "strPathSslKey" in joAccount && typeof joAccount.strPathSslKey == "string" && joAccount.strPathSslKey.length > 0 &&
            "strPathSslCert" in joAccount && typeof joAccount.strPathSslCert == "string" && joAccount.strPathSslCert.length > 0
        ) {
            rpcCallOpts = {
            };
            // details.write( cc.debug( "Will sign via Transaction Manager with SSL options " ) + cc.j( rpcCallOpts ) + "\n" );
        }
        await rpcCall.create( joAccount.strTransactionManagerURL, rpcCallOpts, async function( joCall, err ) {
            if( err ) {
                const s = cc.fatal( "CRITICAL TRANSACTION SIGNING ERROR:" ) + cc.error( " JSON RPC call to Transaction Manager wallet failed" ) + "\n";
                if( verbose_get() >= RV_VERBOSE().error )
                    log.write( s );
                details.write( s );
                if( joCall )
                    await joCall.disconnect();
                return;
            }
            const txAdjusted = JSON.parse( JSON.stringify( rawTx ) ); // tx // rawTx
            if( "chainId" in txAdjusted )
                delete txAdjusted.chainId;
            if( "gasLimit" in txAdjusted && ( ! ( "gas" in txAdjusted ) ) ) {
                txAdjusted.gas = txAdjusted.gasLimit;
                delete txAdjusted.gasLimit;
            }
            const joIn = {
                "transaction_dict": JSON.stringify( txAdjusted )
            };
            details.write( cc.debug( "Calling Transaction Manager to sign-and-send with " ) + cc.j( txAdjusted ) + "\n" );
            await joCall.call(
                joIn,
                async function( joIn, joOut, err ) {
                    const strError = owaspUtils.extract_error_message( err );
                    if( err ) {
                        const s = cc.fatal( "CRITICAL TRANSACTION SIGNING ERROR:" ) + cc.error( " JSON RPC call to Transaction Manager failed, error: " ) + cc.warning( strError ) + "\n";
                        if( verbose_get() >= RV_VERBOSE().error )
                            log.write( s );
                        details.write( s );
                        await joCall.disconnect();
                        return;
                    }
                    details.write( cc.debug( "Transaction Manager sign-and-send result is: " ) + cc.j( joOut ) + "\n" );
                    if( joOut && "data" in joOut && joOut.data && "transaction_hash" in joOut.data )
                        joSR.txHashSent = "" + joOut.data.transaction_hash;
                    else {
                        const s = cc.fatal( "CRITICAL TRANSACTION SIGNING ERROR:" ) + cc.error( " JSON RPC call to Transaction Manager returned bad answer: " ) + cc.j( joOut ) + "\n";
                        if( verbose_get() >= RV_VERBOSE().error )
                            log.write( s );
                        details.write( s );
                        return;
                    }
                    await joCall.disconnect();
                } );
        } );
        await sleep( 5000 );
        await wait_for_transaction_receipt( details, w3, joSR.txHashSent );
        */
        strMsg =
            cc.debug( "Will sign with Transaction Manager wallet, transaction is " ) + cc.j( tx ) +
            cc.debug( ", raw transaction is " ) + cc.j( rawTx )
            // + "\n" + cc.debug( " using account " ) + cc.j( joAccount )
        ;
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
        const txAdjusted = JSON.parse( JSON.stringify( rawTx ) ); // tx // rawTx
        if( "chainId" in txAdjusted )
            delete txAdjusted.chainId;
        if( "gasLimit" in txAdjusted && ( ! ( "gas" in txAdjusted ) ) ) {
            txAdjusted.gas = txAdjusted.gasLimit;
            delete txAdjusted.gasLimit;
        }
        if( redis == null )
            redis = new Redis( joAccount.strTransactionManagerURL );
        const priority = joAccount.tm_priority || 5;
        try {
            strMsg = cc.debug( "Will TM-ensure transaction " ) + cc.j( txAdjusted ) + cc.debug( "..." );
            details.write( strPrefixDetails + strMsg + "\n" );
            log.write( strPrefixLog + strMsg + "\n" );
            const [ tx_id, joReceipt ] = await tm_ensure_transaction( details, w3, priority, txAdjusted );
            strMsg = cc.success( "Done TM-ensure transaction, got ID " ) + cc.notice( tx_id ) + cc.success( " and receipt " ) + cc.j( joReceipt );
            details.write( strPrefixDetails + strMsg + "\n" );
            log.write( strPrefixLog + strMsg + "\n" );
            joSR.txHashSent = "" + joReceipt.transactionHash;
            joSR.joReceipt = joReceipt;
            joSR.tm_tx_id = tx_id;
            strMsg = cc.success( "Done, TX was signed with Transaction Manager" );
            details.write( strPrefixDetails + strMsg + "\n" );
            log.write( strPrefixLog + strMsg + "\n" );
        } catch ( err ) {
            strMsg =
                cc.fatal( "BAD ERROR:" ) + " " + cc.error( "TM - transaction was not sent, underlying error is: " ) +
                cc.warning( owaspUtils.extract_error_message( err ) ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack );
            details.write( strPrefixDetails + strMsg + "\n" );
            log.write( strPrefixLog + strMsg + "\n" );
            // throw err;
        }
    } break;
    case "sgx": {
        strMsg =
            cc.debug( "Will sign with SGX Wallet, transaction is " ) + cc.j( tx ) +
            cc.debug( ", raw transaction is " ) + cc.j( rawTx )
            // + cc.debug( " using account " ) + cc.j( joAccount )
        ;
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
        let rpcCallOpts = null;
        if( "strPathSslKey" in joAccount && typeof joAccount.strPathSslKey == "string" && joAccount.strPathSslKey.length > 0 &&
            "strPathSslCert" in joAccount && typeof joAccount.strPathSslCert == "string" && joAccount.strPathSslCert.length > 0
        ) {
            rpcCallOpts = {
                "cert": fs.readFileSync( joAccount.strPathSslCert, "utf8" ),
                "key": fs.readFileSync( joAccount.strPathSslKey, "utf8" )
            };
            // details.write( cc.debug( "Will sign via SGX with SSL options " ) + cc.j( rpcCallOpts ) + "\n" );
        } else
            details.write( cc.warning( "Will sign via SGX" ) + " " + cc.error( "without SSL options" ) + "\n" );
        await rpcCall.create( joAccount.strSgxURL, rpcCallOpts, async function( joCall, err ) {
            if( err ) {
                const s = cc.fatal( "CRITICAL TRANSACTION SIGNING ERROR:" ) + cc.error( " JSON RPC call to SGX wallet failed" ) + "\n";
                if( verbose_get() >= RV_VERBOSE().error )
                    log.write( s );
                details.write( s );
                if( joCall )
                    await joCall.disconnect();
                return;
            }
            const msgHash = tx.hash( false );
            const strHash = msgHash.toString( "hex" );
            // details.write( cc.debug( "Transaction message hash is " ) + cc.j( msgHash ) + "\n" );
            const joIn = {
                "method": "ecdsaSignMessageHash",
                "params": {
                    "keyName": "" + joAccount.strSgxKeyName,
                    "messageHash": strHash, // "1122334455"
                    "base": 16 // 10
                }
            };
            strMsg = cc.debug( "Calling SGX to sign using ECDSA key with " ) + cc.info( joIn.method ) + cc.debug( "..." );
            details.write( strPrefixDetails + strMsg + "\n" );
            log.write( strPrefixLog + strMsg + "\n" );
            await joCall.call( joIn, async function( joIn, joOut, err ) {
                const strError = owaspUtils.extract_error_message( err );
                if( err ) {
                    strMsg = cc.fatal( "CRITICAL TRANSACTION SIGNING ERROR:" ) + cc.error( " JSON RPC call to SGX wallet failed, error: " ) + cc.warning( strError );
                    details.write( strPrefixDetails + strMsg + "\n" );
                    log.write( strPrefixLog + strMsg + "\n" );
                    await joCall.disconnect();
                    return;
                }
                strMsg = cc.debug( "SGX wallet ECDSA sign result is: " ) + cc.j( joOut );
                details.write( strPrefixDetails + strMsg + "\n" );
                log.write( strPrefixLog + strMsg + "\n" );
                const joNeededResult = {
                    // "v": Buffer.from( owaspUtils.parseIntOrHex( joOut.result.signature_v ).toString( "hex" ), "utf8" ),
                    // "r": Buffer.from( "" + joOut.result.signature_r, "utf8" ),
                    // "s": Buffer.from( "" + joOut.result.signature_s, "utf8" )
                    "v": owaspUtils.parseIntOrHex( joOut.result.signature_v, 10 ),
                    "r": "" + joOut.result.signature_r,
                    "s": "" + joOut.result.signature_s
                };
                strMsg = cc.debug( "SGX Wallet sign result to assign into transaction is: " ) + cc.j( joNeededResult );
                details.write( strPrefixDetails + strMsg + "\n" );
                log.write( strPrefixLog + strMsg + "\n" );
                //
                // if( "_chainId" in tx && tx._chainId != null && tx._chainId != undefined )
                //     tx.v += tx._chainId * 2 + 8;
                // if( "_chainId" in tx && tx._chainId != null && tx._chainId != undefined )
                //     joNeededResult.v += tx._chainId * 2 + 8;
                // if( "_chainId" in tx && tx._chainId != null && tx._chainId != undefined )
                //     joNeededResult.v += tx._chainId * 2 + 8 + 27;
                let chainId = -4;
                // details.write( cc.debug( "...trying tx._chainId = " ) + cc.info( tx._chainId ) + "\n" );
                if( "_chainId" in tx && tx._chainId != null && tx._chainId != undefined ) {
                    chainId = tx._chainId;
                    if( chainId == 0 )
                        chainId = -4;
                }
                // details.write( cc.debug( "...applying chainId = " ) + cc.info( chainId ) + cc.debug( "to v = " ) + cc.info( joNeededResult.v )  + "\n" );
                // joNeededResult.v += chainId * 2 + 8 + 27;
                joNeededResult.v += chainId * 2 + 8 + 27;
                // details.write( cc.debug( "...result v =" ) + cc.info( joNeededResult.v ) + "\n" );
                //
                // joNeededResult.v = to_eth_v( joNeededResult.v, tx._chainId );
                //
                // Object.assign( tx, joNeededResult );
                tx.v = joNeededResult.v;
                tx.r = joNeededResult.r;
                tx.s = joNeededResult.s;
                strMsg = cc.debug( "Resulting adjusted transaction is: " ) + cc.j( tx );
                details.write( strPrefixDetails + strMsg + "\n" );
                log.write( strPrefixLog + strMsg + "\n" );
                await joCall.disconnect();
                strMsg = cc.success( "Done, TX was signed with SGX Wallet" );
                details.write( strPrefixDetails + strMsg + "\n" );
                log.write( strPrefixLog + strMsg + "\n" );
            } );
        } );
        await sleep( 3000 );
    } break;
    case "direct": {
        strMsg =
            cc.debug( "Will sign with private key, transaction is " ) + cc.notice( JSON.stringify( tx ) ) +
            cc.debug( ", raw transaction is " ) + cc.notice( JSON.stringify( rawTx ) )
            // + cc.debug( " using account " ) + cc.j( joAccount )
        ;
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
        const key = Buffer.from( joAccount.privateKey, "hex" ); // convert private key to buffer
        tx.sign( key ); // arg is privateKey as buffer
        strMsg = cc.success( "Done, TX was signed with private key" );
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
    } break;
    default: {
        strMsg = cc.fatal( "CRITICAL TRANSACTION SIGNING ERROR:" ) +
            cc.error( " bad credentials information specified, no explicit SGX and no explicit private key found" )
            // + cc.error( ", account is: " ) + cc.j( joAccount )
        ;
        details.write( strPrefixDetails + strMsg + "\n" );
        log.write( strPrefixLog + strMsg + "\n" );
        if( isExitIfEmpty ) {
            details.exposeDetailsTo( log, "safe_sign_transaction_with_account", false );
            details.close();
            process.exit( 126 );
        }
    } break;
    } // switch( joSR.joACI.strType )
    details.write( cc.debug( "Signed transaction is " ) + cc.notice( JSON.stringify( tx ) ) + "\n" );
    joSR.tx = tx;
    strMsg =
        cc.debug( "Transaction with account completed " ) + cc.notice( "sending counter" ) +
        cc.debug( " is " ) + cc.info( sendingCnt );
    details.write( strPrefixDetails + strMsg + "\n" );
    log.write( strPrefixLog + strMsg + "\n" );
    return joSR;
}

export async function safe_send_signed_transaction( details, w3, serializedTx, strActionName, strLogPrefix ) {
    const strPrefixDetails = cc.debug( "(gathered details)" ) + " ";
    const strPrefixLog = cc.debug( "(immediate log)" ) + " ";
    const strMsg =
        cc.attention( "SEND TRANSACTION" ) + cc.normal( " is using " ) +
        cc.bright( "Web3" ) + cc.normal( " version " ) + cc.sunny( w3.version );
    details.write( strPrefixDetails + strMsg + "\n" );
    log.write( strPrefixLog + strMsg + "\n" );
    const strTX = owaspUtils.ensure_starts_with_0x( serializedTx.toString( "hex" ) ); // strTX is string starting from "0x"
    details.write( strLogPrefix + cc.debug( "....signed raw TX is " ) + cc.attention( strTX ) + "\n" );
    let joReceipt = null;
    let bHaveReceipt = false;
    try {
        joReceipt = await w3.eth.sendSignedTransaction( strTX );
        bHaveReceipt = ( joReceipt != null );
    } catch ( err ) {
        const s = strLogPrefix + cc.fatal( "WARNING:" ) + cc.warning( " first attempt to send signed transaction failure during " + strActionName + ": " ) + cc.sunny( err ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
    }
    if( !bHaveReceipt ) {
        try {
            joReceipt = await w3.eth.sendSignedTransaction( strTX );
        } catch ( err ) {
            const strError = owaspUtils.extract_error_message( err );
            const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " second attempt to send signed transaction failure during " +
                strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
            if( verbose_get() >= RV_VERBOSE().fatal )
                log.write( s );
            details.write( s );
            throw err;
        }
    }
    return joReceipt;
}

//
// register direction for money transfer
// main-net.DepositBox call: function addSchain(string schainName, address tokenManagerAddress)
//
export async function check_is_registered_s_chain_in_deposit_boxes( // step 1
    ethersProvider_main_net,
    jo_linker,
    joAccountMN,
    chain_id_s_chain
) {
    const details = log.createMemoryStream();
    details.write( cc.info( "Main-net " ) + cc.sunny( "Linker" ) + cc.info( "  address is....." ) + cc.bright( jo_linker.address ) + "\n" );
    details.write( cc.info( "S-Chain  " ) + cc.sunny( "ID" ) + cc.info( " is......................." ) + cc.bright( chain_id_s_chain ) + "\n" );
    const strLogPrefix = cc.note( "RegChk S in depositBox:" ) + " ";
    details.write( strLogPrefix + cc.debug( longSeparator ) + "\n" );
    details.write( strLogPrefix + cc.bright( "check_is_registered_s_chain_in_deposit_boxes(reg-step1)" ) + "\n" );
    details.write( strLogPrefix + cc.debug( longSeparator ) + "\n" );
    let strActionName = "";
    try {
        strActionName = "check_is_registered_s_chain_in_deposit_boxes(reg-step1)";
        const addressFrom = joAccountMN.address();
        const bIsRegistered = await jo_linker.callStatic.hasSchain( chain_id_s_chain, { from: addressFrom } );
        details.write( strLogPrefix + cc.success( "check_is_registered_s_chain_in_deposit_boxes(reg-step1) status is: " ) + cc.attention( bIsRegistered ) + "\n" );
        if( expose_details_get() )
            details.exposeDetailsTo( log, "check_is_registered_s_chain_in_deposit_boxes", true );
        details.close();
        return bIsRegistered;
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in check_is_registered_s_chain_in_deposit_boxes(reg-step1)() during " +
            strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "check_is_registered_s_chain_in_deposit_boxes", false );
        details.close();
    }
    return false;
}

export async function invoke_has_chain(
    details,
    ethersProvider, // Main-Net or S-Chin
    jo_linker, // Main-Net or S-Chin
    joAccount, // Main-Net or S-Chin
    chain_id_s_chain
) {
    const strLogPrefix = cc.sunny( "Wait for added chain status:" ) + " ";
    const strActionName = "invoke_has_chain(hasSchain): jo_linker.hasSchain";
    try {
        details.write( strLogPrefix + cc.debug( "Will call " ) + cc.notice( strActionName ) + cc.debug( "..." ) + "\n" );
        const addressFrom = joAccount.address();
        const bHasSchain = await jo_linker.callStatic.hasSchain( chain_id_s_chain, { from: addressFrom } );
        details.write( strLogPrefix + cc.success( "Got jo_linker.hasSchain() status is: " ) + cc.attention( bHasSchain ) + "\n" );
        return bHasSchain;
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( "Error in invoke_has_chain() during " + strActionName + ": " ) +
            cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
    }
    return false;
}

export async function wait_for_has_chain(
    details,
    w3, // Main-Net or S-Chin
    jo_linker, // Main-Net or S-Chin
    joAccount, // Main-Net or S-Chin
    chain_id_s_chain,
    cntWaitAttempts,
    nSleepMilliseconds
) {
    if( cntWaitAttempts == null || cntWaitAttempts == undefined )
        cntWaitAttempts = 100;
    if( nSleepMilliseconds == null || nSleepMilliseconds == undefined )
        nSleepMilliseconds = 5;
    for( let idxWaitAttempts = 0; idxWaitAttempts < cntWaitAttempts; ++ idxWaitAttempts ) {
        if( await invoke_has_chain( details, w3, jo_linker, joAccount, chain_id_s_chain ) )
            return true;
        details.write( cc.normal( "Sleeping " ) + cc.info( nSleepMilliseconds ) + cc.normal( " milliseconds..." ) + "\n" );
        await sleep( nSleepMilliseconds );
    }
    return false;
}

export async function register_s_chain_in_deposit_boxes( // step 1
    ethersProvider_main_net,
    // jo_deposit_box_eth, // only main net
    // jo_deposit_box_erc20, // only main net
    // jo_deposit_box_erc721, // only main net
    jo_linker,
    joAccountMN,
    jo_token_manager_eth, // only s-chain
    jo_token_manager_erc20, // only s-chain
    jo_token_manager_erc721, // only s-chain
    jo_token_manager_erc1155, // only s-chain
    jo_token_manager_erc721_with_metadata, // only s-chain
    jo_community_locker, // only s-chain
    jo_token_manager_linker,
    chain_id_s_chain,
    cid_main_net,
    tc_main_net,
    cntWaitAttempts,
    nSleepMilliseconds
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // register_s_chain_in_deposit_boxes
    details.write( cc.info( "Main-net " ) + cc.sunny( "Linker" ) + cc.info( "  address is......." ) + cc.bright( jo_linker.address ) + "\n" );
    details.write( cc.info( "S-Chain  " ) + cc.sunny( "ID" ) + cc.info( " is......................." ) + cc.bright( chain_id_s_chain ) + "\n" );
    const strLogPrefix = cc.sunny( "Reg S in depositBoxes:" ) + " ";
    details.write( strLogPrefix + cc.debug( longSeparator ) + "\n" );
    details.write( strLogPrefix + cc.bright( "reg-step1:register_s_chain_in_deposit_boxes" ) + "\n" );
    details.write( strLogPrefix + cc.debug( longSeparator ) + "\n" );
    let strActionName = "";
    try {
        strActionName = "Register S-chain in deposit boxes, step 1, connectSchain";
        details.write( strLogPrefix + cc.debug( "Will register S-Chain in lock_and_data on Main-net" ) + "\n" );
        const arrArguments = [
            chain_id_s_chain,
            [
                jo_token_manager_linker.address, // call params
                jo_community_locker.address, // call params
                jo_token_manager_eth.address, // call params
                jo_token_manager_erc20.address, // call params
                jo_token_manager_erc721.address, // call params
                jo_token_manager_erc1155.address, // call params
                jo_token_manager_erc721_with_metadata.address // call params
            ]
        ];
        const weiHowMuch = undefined;
        const gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "Linker", jo_linker, "connectSchain", arrArguments,
                joAccountMN, strActionName,
                gasPrice, 3000000, weiHowMuch,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas ) + "\n" );
        const isIgnore = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "Linker", jo_linker, "connectSchain", arrArguments,
                joAccountMN, strActionName, isIgnore,
                gasPrice, estimatedGas, weiHowMuch,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        const joReceipt =
            await payed_call(
                details,
                ethersProvider_main_net,
                "Linker", jo_linker, "connectSchain", arrArguments,
                joAccountMN, strActionName,
                gasPrice, estimatedGas, weiHowMuch,
                null
            );
        if( joReceipt && typeof joReceipt == "object" ) {
            jarrReceipts.push( {
                "description": "register_s_chain_in_deposit_boxes",
                "receipt": joReceipt
            } );
        }

        const isSChainStatusOKay = await wait_for_has_chain(
            details,
            ethersProvider_main_net,
            jo_linker,
            joAccountMN,
            chain_id_s_chain,
            cntWaitAttempts,
            nSleepMilliseconds
        );
        if( ! isSChainStatusOKay )
            throw new Error( "S-Chain ownership status check timeout" );
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in register_s_chain_in_deposit_boxes() during " + strActionName + ": " ) +
            cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "register_s_chain_in_deposit_boxes", false );
        details.close();
        return null;
    }
    if( expose_details_get() )
        details.exposeDetailsTo( log, "register_s_chain_in_deposit_boxes", true );
    details.close();
    return jarrReceipts;
} // async function register_deposit_box_on_s_chain(...

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function reimbursement_show_balance(
    ethersProvider_main_net,
    jo_community_pool,
    joReceiver_main_net,
    strChainName_main_net,
    cid_main_net,
    tc_main_net,
    strReimbursementChain,
    isForcePrintOut
) {
    const details = log.createMemoryStream();
    let s = "";
    const strLogPrefix = cc.info( "Gas Reimbursement - Show Balance" ) + " ";
    try {
        const addressFrom = joReceiver_main_net;
        details.write( strLogPrefix +
            cc.debug( "Querying wallet " ) + cc.notice( strReimbursementChain ) +
            cc.debug( "/" ) + cc.info( addressFrom ) +
            cc.debug( " balance..." ) + "\n" );
        const xWei = await jo_community_pool.callStatic.getBalance( addressFrom, strReimbursementChain, { from: addressFrom } );
        //
        s = strLogPrefix + cc.success( "Balance(wei): " ) + cc.attention( xWei ) + "\n";
        if( isForcePrintOut || verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        //
        const xEth = owaspUtils.ethersMod.ethers.utils.formatEther( owaspUtils.toBN( xWei ) );
        s = strLogPrefix + cc.success( "Balance(eth): " ) + cc.attention( xEth ) + "\n";
        if( isForcePrintOut || verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        //
        if( expose_details_get() )
            details.exposeDetailsTo( log, "reimbursement_show_balance", true );
        details.close();
        return xWei;
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in reimbursement_show_balance(): " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "reimbursement_show_balance", false );
        details.close();
        return 0;
    }
}

export async function reimbursement_estimate_amount(
    ethersProvider_main_net,
    jo_community_pool,
    joReceiver_main_net,
    strChainName_main_net,
    cid_main_net,
    tc_main_net,
    strReimbursementChain,
    isForcePrintOut
) {
    const details = log.createMemoryStream();
    let s = "";
    const strLogPrefix = cc.info( "Gas Reimbursement - Estimate Amount To Recharge" ) + " ";
    try {
        details.write( strLogPrefix + cc.debug( "Querying wallet " ) + cc.notice( strReimbursementChain ) + cc.debug( " balance..." ) + "\n" );
        const addressReceiver = joReceiver_main_net;
        const xWei = await jo_community_pool.callStatic.getBalance( addressReceiver, strReimbursementChain, { from: addressReceiver } );
        //
        s = strLogPrefix + cc.success( "Balance(wei): " ) + cc.attention( xWei ) + "\n";
        if( isForcePrintOut || verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        //
        const xEth = owaspUtils.ethersMod.ethers.utils.formatEther( owaspUtils.toBN( xWei ) );
        s = strLogPrefix + cc.success( "Balance(eth): " ) + cc.attention( xEth ) + "\n";
        if( isForcePrintOut || verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        //
        const minTransactionGas = owaspUtils.parseIntOrHex( await jo_community_pool.callStatic.minTransactionGas( { from: addressReceiver } ) );
        s = strLogPrefix + cc.success( "MinTransactionGas: " ) + cc.attention( minTransactionGas ) + "\n";
        if( isForcePrintOut || verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        //
        const gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        s = strLogPrefix + cc.success( "Multiplied Gas Price: " ) + cc.attention( gasPrice ) + "\n";
        if( isForcePrintOut || verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        //
        const minAmount = minTransactionGas * gasPrice;
        s = strLogPrefix + cc.success( "Minimum recharge balance: " ) + cc.attention( minAmount ) + "\n";
        if( isForcePrintOut || verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        //
        let amountToRecharge = 0;
        if( xWei >= minAmount )
            amountToRecharge = 1;
        else
            amountToRecharge = minAmount - xWei;

        s = strLogPrefix + cc.success( "Estimated amount to recharge(wei): " ) + cc.attention( amountToRecharge ) + "\n";
        if( isForcePrintOut || verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        //
        const amountToRechargeEth = owaspUtils.ethersMod.ethers.utils.formatEther( owaspUtils.toBN( amountToRecharge.toString() ) );
        s = strLogPrefix + cc.success( "Estimated amount to recharge(eth): " ) + cc.attention( amountToRechargeEth ) + "\n";
        if( isForcePrintOut || verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        //
        if( expose_details_get() )
            details.exposeDetailsTo( log, "reimbursement_estimate_amount", true );
        details.close();
        return amountToRecharge;
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in reimbursement_estimate_amount(): " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "reimbursement_estimate_amount", false );
        details.close();
        return 0;
    }
}

export async function reimbursement_wallet_recharge(
    ethersProvider_main_net,
    jo_community_pool,
    joAccountMN,
    strChainName_main_net,
    cid_main_net,
    tc_main_net,
    strReimbursementChain,
    nReimbursementRecharge
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // reimbursement_wallet_recharge
    let strActionName = "";
    const strLogPrefix = cc.info( "Gas Reimbursement - Wallet Recharge" ) + " ";
    try {
        details.write( strLogPrefix + cc.debug( "Recharging wallet " ) + cc.notice( strReimbursementChain ) + cc.debug( "..." ) + "\n" );
        strActionName = "Recharge reimbursement wallet on Main Net";
        const addressReceiver = joAccountMN.address();
        const arrArguments = [
            strReimbursementChain,
            addressReceiver
        ];
        const gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "CommunityPool", jo_community_pool, "rechargeUserWallet", arrArguments,
                joAccountMN, strActionName,
                gasPrice, 3000000, nReimbursementRecharge,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas ) + "\n" );
        const isIgnore = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "CommunityPool", jo_community_pool, "rechargeUserWallet", arrArguments,
                joAccountMN, strActionName, isIgnore,
                gasPrice, estimatedGas, nReimbursementRecharge,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        const joReceipt =
            await payed_call(
                details,
                ethersProvider_main_net,
                "CommunityPool", jo_community_pool, "rechargeUserWallet", arrArguments,
                joAccountMN, strActionName,
                gasPrice, estimatedGas, nReimbursementRecharge,
                null
            );
        if( joReceipt && typeof joReceipt == "object" ) {
            jarrReceipts.push( {
                "description": "reimbursement_wallet_recharge",
                "receipt": joReceipt
            } );
        }
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "reimbursement_wallet_recharge", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "REIMBURSEMENT_WALLET_RECHARGE", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "reimbursement_wallet_recharge", true );
    details.close();
    return true;
}

export async function reimbursement_wallet_withdraw(
    ethersProvider_main_net,
    jo_community_pool,
    joAccountMN,
    strChainName_main_net,
    cid_main_net,
    tc_main_net,
    strReimbursementChain,
    nReimbursementWithdraw
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // reimbursement_wallet_withdraw
    let strActionName = "";
    const strLogPrefix = cc.info( "Gas Reimbursement - Wallet Withdraw" ) + " ";
    try {
        details.write( strLogPrefix + cc.debug( "Withdrawing wallet " ) + cc.notice( strReimbursementChain ) + cc.debug( "..." ) + "\n" );
        strActionName = "Withdraw reimbursement wallet";
        const arrArguments = [
            strReimbursementChain,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( nReimbursementWithdraw ).toHexString() )
        ];
        const weiHowMuch = undefined;
        const gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "CommunityPool", jo_community_pool, "withdrawFunds", arrArguments,
                joAccountMN, strActionName,
                gasPrice, 3000000, weiHowMuch,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas ) + "\n" );
        const isIgnore = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "CommunityPool", jo_community_pool, "withdrawFunds", arrArguments,
                joAccountMN, strActionName, isIgnore,
                gasPrice, estimatedGas, weiHowMuch,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        const joReceipt =
            await payed_call(
                details,
                ethersProvider_main_net,
                "CommunityPool", jo_community_pool, "withdrawFunds", arrArguments,
                joAccountMN, strActionName,
                gasPrice, estimatedGas, weiHowMuch,
                null
            );
        if( joReceipt && typeof joReceipt == "object" ) {
            jarrReceipts.push( {
                "description": "reimbursement_wallet_withdraw",
                "receipt": joReceipt
            } );
        }
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "reimbursement_wallet_withdraw", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "REIMBURSEMENT_WALLET_WITHDRAW", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "reimbursement_wallet_withdraw", true );
    details.close();
    return true;
}

export async function reimbursement_set_range(
    ethersProvider_s_chain,
    jo_community_locker,
    joAccountSC,
    strChainName_s_chain,
    cid_s_chain,
    tc_s_chain,
    strChainName_origin_chain,
    nReimbursementRange
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // reimbursement_set_range
    let strActionName = "";
    const strLogPrefix = cc.info( "Gas Reimbursement - Set Minimal time interval from S2M transfers" ) + " ";
    try {
        details.write( strLogPrefix + cc.debug( "Setting minimal S2M interval to " ) + cc.notice( nReimbursementRange ) + cc.debug( "..." ) + "\n" );
        strActionName = "Set reimbursement range";
        const arrArguments = [
            strChainName_origin_chain,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( nReimbursementRange ).toHexString() )
        ];
        const weiHowMuch = undefined;
        const gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "CommunityLocker", jo_community_locker, "setTimeLimitPerMessage", arrArguments,
                joAccountSC, strActionName,
                gasPrice, 3000000, weiHowMuch,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas ) + "\n" );
        const isIgnore = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "CommunityLocker", jo_community_locker, "setTimeLimitPerMessage", arrArguments,
                joAccountSC, strActionName, isIgnore,
                gasPrice, estimatedGas, weiHowMuch,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        let opts = {
            isCheckTransactionToSchain: true
        };
        const joReceipt =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "CommunityLocker", jo_community_locker, "setTimeLimitPerMessage", arrArguments,
                joAccountSC, strActionName,
                gasPrice, estimatedGas, weiHowMuch,
                opts
            );
        if( joReceipt && typeof joReceipt == "object" ) {
            jarrReceipts.push( {
                "description": "reimbursement_set_range",
                "receipt": joReceipt
            } );
        }
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "reimbursement_set_range", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "REIMBURSEMENT_SET_RANGE", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "reimbursement_set_range", true );
    details.close();
    return true;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// transfer money from main-net to S-chain
// main-net.DepositBox call: function deposit(string schainName, address to) public payable
// Where:
//   schainName...obvious
//   to.........address in S-chain
// Notice:
//   this function is available for everyone in main-net
//   money is sent from caller
//   "value" JSON arg is used to specify amount of money to sent
//
export async function do_eth_payment_from_main_net(
    ethersProvider_main_net,
    cid_main_net,
    joAccountSrc,
    joAccountDst,
    jo_deposit_box,
    jo_message_proxy_main_net, // for checking logs
    chain_id_s_chain,
    weiHowMuch, // how much WEI money to send
    tc_main_net
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_eth_payment_from_main_net
    let strActionName = "";
    const strLogPrefix = cc.info( "M2S ETH Payment:" ) + " ";
    try {
        details.write( strLogPrefix + cc.debug( "Doing payment from mainnet with " ) + cc.notice( "chain_id_s_chain" ) + cc.debug( "=" ) + cc.notice( chain_id_s_chain ) + cc.debug( "..." ) + "\n" );
        strActionName = "ETH payment from Main Net, deposit";
        const arrArguments = [
            chain_id_s_chain
        ];
        const gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "DepositBox", jo_deposit_box, "deposit", arrArguments,
                joAccountSrc, strActionName,
                gasPrice, 3000000, weiHowMuch,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas ) + "\n" );
        const isIgnore = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "DepositBox", jo_deposit_box, "deposit", arrArguments,
                joAccountSrc, strActionName, isIgnore,
                gasPrice, estimatedGas, weiHowMuch,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        const joReceipt =
            await payed_call(
                details,
                ethersProvider_main_net,
                "DepositBox", jo_deposit_box, "deposit", arrArguments,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas, weiHowMuch,
                null
            );
        if( joReceipt && typeof joReceipt == "object" ) {
            jarrReceipts.push( {
                "description": "do_eth_payment_from_main_net",
                "receipt": joReceipt
            } );
        }

        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_main_net ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_main_net, jo_message_proxy_main_net,
                    strEventName, joReceipt.blockNumber, joReceipt.transactionHash,
                    jo_message_proxy_main_net.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for the \"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_main_net.address + " contract, no events found" );
        } // if( jo_message_proxy_main_net )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_eth_payment_from_main_net", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ETH PAYMENT FROM MAIN NET", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_eth_payment_from_main_net", true );
    details.close();
    return true;
} // async function do_eth_payment_from_main_net(...

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// transfer money from S-chain to main-net
// S-chain.TokenManager call: function exitToMain(address to) public payable
// Where:
//   to.........address in main-net
// Notice:
//   this function is available for everyone in S-chain
//   money is sent from caller
//   "value" JSON arg is used to specify amount of money to sent
//
export async function do_eth_payment_from_s_chain(
    ethersProvider_s_chain,
    cid_s_chain,
    joAccountSrc,
    joAccountDst,
    jo_token_manager_eth,
    jo_message_proxy_s_chain, // for checking logs
    weiHowMuch, // how much WEI money to send
    tc_s_chain
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_eth_payment_from_s_chain
    let strActionName = "";
    const strLogPrefix = cc.info( "S2M ETH Payment:" ) + " ";
    try {
        strActionName = "ETH payment from S-Chain, exitToMain";
        const arrArguments = [
            owaspUtils.toBN( weiHowMuch )
        ];
        const gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" ); //
        const estimatedGas =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "TokenManagerETH", jo_token_manager_eth, "exitToMain", arrArguments,
                joAccountSrc, strActionName,
                gasPrice, 6000000, 0, // weiHowMuch
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas ) + "\n" );
        const isIgnore = true;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerETH", jo_token_manager_eth, "exitToMain", arrArguments,
                joAccountSrc, strActionName, isIgnore,
                gasPrice, estimatedGas, 0, // weiHowMuch
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        let opts = {
            isCheckTransactionToSchain: true
        };
        const joReceipt =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerETH", jo_token_manager_eth, "exitToMain", arrArguments,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas, 0, // weiHowMuch
                opts
            );
        if( joReceipt && typeof joReceipt == "object" ) {
            jarrReceipts.push( {
                "description": "do_eth_payment_from_s_chain",
                "receipt": joReceipt
            } );
        }

        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_s_chain ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_s_chain, jo_message_proxy_s_chain,
                    strEventName, joReceipt.blockNumber, joReceipt.transactionHash,
                    jo_message_proxy_s_chain.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for the \"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_s_chain.address + " contract, no events found" );
        } // if( jo_message_proxy_s_chain )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_eth_payment_from_s_chain", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ETH PAYMENT FROM S-CHAIN", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_eth_payment_from_s_chain", true );
    details.close();
    return true;
} // async function do_eth_payment_from_s_chain(...

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
export async function receive_eth_payment_from_s_chain_on_main_net(
    ethersProvider_main_net,
    cid_main_net,
    joAccountMN,
    jo_deposit_box_eth,
    tc_main_net
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // receive_eth_payment_from_s_chain_on_main_net
    let strActionName = "";
    const strLogPrefix = cc.info( "M2S ETH Receive:" ) + " ";
    try {
        strActionName = "Receive ETH payment from S-Chain on Main Met, getMyEth";
        const arrArguments = [];
        const weiHowMuch = undefined;
        const gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "DepositBoxETH", jo_deposit_box_eth, "getMyEth", arrArguments,
                joAccountMN, strActionName,
                gasPrice, 3000000, weiHowMuch,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas ) + "\n" );
        const isIgnore = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "DepositBoxETH", jo_deposit_box_eth, "getMyEth", arrArguments,
                joAccountMN, strActionName, isIgnore,
                gasPrice, estimatedGas, weiHowMuch,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        const joReceipt =
            await payed_call(
                details,
                ethersProvider_main_net,
                "DepositBoxETH", jo_deposit_box_eth, "getMyEth", arrArguments,
                joAccountMN, strActionName,
                gasPrice, estimatedGas, weiHowMuch,
                null
            );
        if( joReceipt && typeof joReceipt == "object" ) {
            jarrReceipts.push( {
                "description": "receive_eth_payment_from_s_chain_on_main_net",
                "receipt": joReceipt
            } );
        }
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Receive payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "receive_eth_payment_from_s_chain_on_main_net", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "RECEIVE ETH ON MAIN NET", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "receive_eth_payment_from_s_chain_on_main_net", true );
    details.close();
    return true;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function view_eth_payment_from_s_chain_on_main_net(
    ethersProvider_main_net,
    joAccountMN,
    jo_deposit_box_eth
) {
    const details = log.createMemoryStream();
    const strActionName = "";
    const strLogPrefix = cc.info( "S ETH View:" ) + " ";
    try {
        if( ! ( ethersProvider_main_net && joAccountMN && jo_deposit_box_eth ) )
            return null;
        const addressFrom = joAccountMN.address();
        const xWei = await jo_deposit_box_eth.callStatic.approveTransfers( addressFrom, { from: addressFrom } );
        details.write( strLogPrefix + cc.success( "You can receive(wei): " ) + cc.attention( xWei ) + "\n" );
        const xEth = owaspUtils.ethersMod.ethers.utils.formatEther( owaspUtils.toBN( xWei ) );
        const s = strLogPrefix + cc.success( "You can receive(eth): " ) + cc.attention( xEth ) + "\n";
        if( verbose_get() >= RV_VERBOSE().information )
            log.write( s );
        details.write( s );
        if( expose_details_get() )
            details.exposeDetailsTo( log, "view_eth_payment_from_s_chain_on_main_net", true );
        details.close();
        return xWei;
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " View payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "view_eth_payment_from_s_chain_on_main_net", false );
        details.close();
        return null;
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function do_erc721_payment_from_main_net(
    ethersProvider_main_net,
    ethersProvider_s_chain,
    cid_main_net,
    cid_s_chain,
    joAccountSrc,
    joAccountDst,
    jo_deposit_box_erc721,
    jo_message_proxy_main_net, // for checking logs
    chain_id_s_chain,
    token_id, // which ERC721 token id to send
    weiHowMuch, // how much ETH
    jo_token_manager_erc721, // only s-chain
    strCoinNameErc721_main_net,
    erc721PrivateTestnetJson_main_net,
    strCoinNameErc721_s_chain,
    erc721PrivateTestnetJson_s_chain,
    tc_main_net
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc721_payment_from_main_net
    let strActionName = "";
    const strLogPrefix = cc.info( "M2S ERC721 Payment:" ) + " ";
    try {
        strActionName = "ERC721 payment from Main Net, approve";
        const erc721ABI = erc721PrivateTestnetJson_main_net[strCoinNameErc721_main_net + "_abi"];
        const erc721Address_main_net = erc721PrivateTestnetJson_main_net[strCoinNameErc721_main_net + "_address"];
        const contractERC721 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc721Address_main_net,
                erc721ABI,
                ethersProvider_main_net
            );
        const depositBoxAddress = jo_deposit_box_erc721.address;
        const arrArguments_approve = [
            depositBoxAddress,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() )
        ];
        const arrArguments_depositERC721 = [
            chain_id_s_chain,
            erc721Address_main_net,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "ERC721", contractERC721, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "ERC721", contractERC721, "approve", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        const joReceiptApprove =
            await payed_call(
                details,
                ethersProvider_main_net,
                "ERC721", contractERC721, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( joReceiptApprove && typeof joReceiptApprove == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc721_payment_from_main_net/approve",
                "receipt": joReceiptApprove
            } );
        }

        strActionName = "ERC721 payment from Main Net, depositERC721";
        const weiHowMuch_depositERC721 = undefined;
        gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_deposit =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "DepositBoxERC721", jo_deposit_box_erc721, "depositERC721", arrArguments_depositERC721,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_depositERC721,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(deposit) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_deposit ) + "\n" );
        const isIgnore_depositERC721 = true;
        const strErrorOfDryRun_depositERC721 =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "DepositBoxERC721", jo_deposit_box_erc721, "depositERC721", arrArguments_depositERC721,
                joAccountSrc, strActionName, isIgnore_depositERC721,
                gasPrice, estimatedGas_deposit, weiHowMuch_depositERC721,
                null
            );
        if( strErrorOfDryRun_depositERC721 )
            throw new Error( strErrorOfDryRun_depositERC721 );

        const joReceiptDeposit =
            await payed_call(
                details,
                ethersProvider_main_net,
                "DepositBoxERC721", jo_deposit_box_erc721, "depositERC721", arrArguments_depositERC721,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_deposit, weiHowMuch_depositERC721,
                null
            );
        if( joReceiptDeposit && typeof joReceiptDeposit == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc721_payment_from_main_net/deposit",
                "receipt": joReceiptDeposit
            } );
        }

        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_main_net ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_main_net, jo_message_proxy_main_net,
                    strEventName, joReceiptDeposit.blockNumber, joReceiptDeposit.transactionHash,
                    jo_message_proxy_main_net.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for the \"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_main_net.address + " contract, no events found" );
        } // if( jo_message_proxy_main_net )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc721_payment_from_main_net", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-721 PAYMENT FROM MAIN NET", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc721_payment_from_main_net", true );
    details.close();
    return true;
} // async function do_erc721_payment_from_main_net(...

//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
export async function do_erc20_payment_from_main_net(
    ethersProvider_main_net,
    ethersProvider_s_chain,
    cid_main_net,
    cid_s_chain,
    joAccountSrc,
    joAccountDst,
    jo_deposit_box_erc20,
    jo_message_proxy_main_net, // for checking logs
    chain_id_s_chain,
    token_amount, // how much ERC20 tokens to send
    weiHowMuch, // how much ETH
    jo_token_manager_erc20, // only s-chain
    strCoinNameErc20_main_net,
    erc20_main_net,
    strCoinNameErc20_s_chain,
    erc20_s_chain,
    tc_main_net
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc20_payment_from_main_net
    let strActionName = "";
    const strLogPrefix = cc.info( "M2S ERC20 Payment:" ) + " ";
    try {
        strActionName = "ERC20 payment from Main Net, approve";
        const erc20ABI = erc20_main_net[strCoinNameErc20_main_net + "_abi"];
        const erc20Address_main_net = erc20_main_net[strCoinNameErc20_main_net + "_address"];
        const contractERC20 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc20Address_main_net,
                erc20ABI,
                ethersProvider_main_net
            );
        const depositBoxAddress = jo_deposit_box_erc20.address;
        const arrArguments_approve = [
            depositBoxAddress,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_amount ).toHexString() )
        ];
        const arrArguments_depositERC20 = [
            chain_id_s_chain,
            erc20Address_main_net,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_amount ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "ERC20", contractERC20, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "ERC20", contractERC20, "approve", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        const joReceiptApprove =
            await payed_call(
                details,
                ethersProvider_main_net,
                "ERC20", contractERC20, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( joReceiptApprove && typeof joReceiptApprove == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc20_payment_from_main_net/approve",
                "receipt": joReceiptApprove
            } );
        }

        strActionName = "ERC20 payment from Main Net, depositERC20";
        const weiHowMuch_depositERC20 = undefined;
        gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_deposit =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "DepositBoxERC20", jo_deposit_box_erc20, "depositERC20", arrArguments_depositERC20,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_depositERC20,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(deposit) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_deposit ) + "\n" );
        const isIgnore_depositERC20 = true;
        const strErrorOfDryRun_depositERC20 =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "DepositBoxERC20", jo_deposit_box_erc20, "depositERC20", arrArguments_depositERC20,
                joAccountSrc, strActionName, isIgnore_depositERC20,
                gasPrice, estimatedGas_deposit, weiHowMuch_depositERC20,
                null
            );
        if( strErrorOfDryRun_depositERC20 )
            throw new Error( strErrorOfDryRun_depositERC20 );

        const joReceiptDeposit =
            await payed_call(
                details,
                ethersProvider_main_net,
                "DepositBoxERC20", jo_deposit_box_erc20, "depositERC20", arrArguments_depositERC20,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_deposit, weiHowMuch_depositERC20,
                null
            );
        if( joReceiptDeposit && typeof joReceiptDeposit == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc20_payment_from_main_net/deposit",
                "receipt": joReceiptDeposit
            } );
        }

        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_main_net ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_main_net, jo_message_proxy_main_net,
                    strEventName, joReceiptDeposit.blockNumber, joReceiptDeposit.transactionHash,
                    jo_message_proxy_main_net.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for th\"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_main_net.address + " contract, no events found" );
        } // if( jo_message_proxy_main_net )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc20_payment_from_main_net", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-20 PAYMENT FROM MAIN NET", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc20_payment_from_main_net", true );
    details.close();
    return true;
} // async function do_erc20_payment_from_main_net(...

export async function do_erc1155_payment_from_main_net(
    ethersProvider_main_net,
    ethersProvider_s_chain,
    cid_main_net,
    cid_s_chain,
    joAccountSrc,
    joAccountDst,
    jo_deposit_box_erc1155,
    jo_message_proxy_main_net, // for checking logs
    chain_id_s_chain,
    token_id, // which ERC1155 token id to send
    token_amount, // which ERC1155 token id to send
    weiHowMuch, // how much ETH
    jo_token_manager_erc1155, // only s-chain
    strCoinNameErc1155_main_net,
    erc1155PrivateTestnetJson_main_net,
    strCoinNameErc1155_s_chain,
    erc1155PrivateTestnetJson_s_chain,
    tc_main_net
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc1155_payment_from_main_net
    let strActionName = "";
    const strLogPrefix = cc.info( "M2S ERC1155 Payment:" ) + " ";
    try {
        strActionName = "ERC1155 payment from Main Net, approve";
        const erc1155ABI = erc1155PrivateTestnetJson_main_net[strCoinNameErc1155_main_net + "_abi"];
        const erc1155Address_main_net = erc1155PrivateTestnetJson_main_net[strCoinNameErc1155_main_net + "_address"];
        const contractERC1155 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc1155Address_main_net,
                erc1155ABI,
                ethersProvider_main_net
            );
        const depositBoxAddress = jo_deposit_box_erc1155.address;
        const arrArguments_approve = [
            // joAccountSrc.address(),
            depositBoxAddress,
            true
        ];
        const arrArguments_depositERC1155 = [
            chain_id_s_chain,
            erc1155Address_main_net,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() ),
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_amount ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        const joReceiptApprove =
            await payed_call(
                details,
                ethersProvider_main_net,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( joReceiptApprove && typeof joReceiptApprove == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_payment_from_main_net/approve",
                "receipt": joReceiptApprove
            } );
        }

        strActionName = "ERC1155 payment from Main Net, depositERC1155";
        const weiHowMuch_depositERC1155 = undefined;
        gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_deposit =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "DepositBoxERC1155", jo_deposit_box_erc1155, "depositERC1155", arrArguments_depositERC1155,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_depositERC1155,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(deposit) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_deposit ) + "\n" );
        const isIgnore_depositERC1155 = true;
        const strErrorOfDryRun_depositERC1155 =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "DepositBoxERC1155", jo_deposit_box_erc1155, "depositERC1155", arrArguments_depositERC1155,
                joAccountSrc, strActionName, isIgnore_depositERC1155,
                gasPrice, estimatedGas_deposit, weiHowMuch_depositERC1155,
                null
            );
        if( strErrorOfDryRun_depositERC1155 )
            throw new Error( strErrorOfDryRun_depositERC1155 );

        const joReceiptDeposit =
            await payed_call(
                details,
                ethersProvider_main_net,
                "DepositBoxERC1155", jo_deposit_box_erc1155, "depositERC1155", arrArguments_depositERC1155,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_deposit, weiHowMuch_depositERC1155,
                null
            );
        if( joReceiptDeposit && typeof joReceiptDeposit == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_payment_from_main_net/deposit",
                "receipt": joReceiptDeposit
            } );
        }

        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_main_net ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_main_net, jo_message_proxy_main_net,
                    strEventName, joReceiptDeposit.blockNumber, joReceiptDeposit.transactionHash,
                    jo_message_proxy_main_net.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for the \"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_main_net.address + " contract, no events found" );
        } // if( jo_message_proxy_main_net )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc1155_payment_from_main_net", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-1155 PAYMENT FROM MAIN NET", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc1155_payment_from_main_net", true );
    details.close();
    return true;
} // async function do_erc1155_payment_from_main_net(...

export async function do_erc1155_batch_payment_from_main_net(
    ethersProvider_main_net,
    ethersProvider_s_chain,
    cid_main_net,
    cid_s_chain,
    joAccountSrc,
    joAccountDst,
    jo_deposit_box_erc1155,
    jo_message_proxy_main_net, // for checking logs
    chain_id_s_chain,
    token_ids, // which ERC1155 token id to send
    token_amounts, // which ERC1155 token id to send
    weiHowMuch, // how much ETH
    jo_token_manager_erc1155, // only s-chain
    strCoinNameErc1155_main_net,
    erc1155PrivateTestnetJson_main_net,
    strCoinNameErc1155_s_chain,
    erc1155PrivateTestnetJson_s_chain,
    tc_main_net
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc1155_batch_payment_from_main_net
    let strActionName = "";
    const strLogPrefix = cc.info( "M2S ERC1155 Batch Payment:" ) + " ";
    try {
        strActionName = "ERC1155 batch-payment from Main Net, approve";
        const erc1155ABI = erc1155PrivateTestnetJson_main_net[strCoinNameErc1155_main_net + "_abi"];
        const erc1155Address_main_net = erc1155PrivateTestnetJson_main_net[strCoinNameErc1155_main_net + "_address"];
        const contractERC1155 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc1155Address_main_net,
                erc1155ABI,
                ethersProvider_main_net
            );
        const depositBoxAddress = jo_deposit_box_erc1155.address;
        const arrArguments_approve = [
            // joAccountSrc.address(),
            depositBoxAddress,
            true
        ];
        const arrArguments_depositERC1155Batch = [
            chain_id_s_chain,
            erc1155Address_main_net,
            token_ids, //owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() ),
            token_amounts //owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_amount ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        const joReceiptApprove =
            await payed_call(
                details,
                ethersProvider_main_net,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( joReceiptApprove && typeof joReceiptApprove == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_batch_payment_from_main_net/approve",
                "receipt": joReceiptApprove
            } );
        }

        strActionName = "ERC1155 batch-payment from Main Net, depositERC1155Batch";
        const weiHowMuch_depositERC1155Batch = undefined;
        gasPrice = await tc_main_net.computeGasPrice( ethersProvider_main_net, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_deposit =
            await tc_main_net.computeGas(
                details,
                ethersProvider_main_net,
                "DepositBoxERC1155", jo_deposit_box_erc1155, "depositERC1155Batch", arrArguments_depositERC1155Batch,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_depositERC1155Batch,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(deposit) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_deposit ) + "\n" );
        const isIgnore_depositERC1155Batch = true;
        const strErrorOfDryRun_depositERC1155Batch =
            await dry_run_call(
                details,
                ethersProvider_main_net,
                "DepositBoxERC1155", jo_deposit_box_erc1155, "depositERC1155Batch", arrArguments_depositERC1155Batch,
                joAccountSrc, strActionName, isIgnore_depositERC1155Batch,
                gasPrice, estimatedGas_deposit, weiHowMuch_depositERC1155Batch,
                null
            );
        if( strErrorOfDryRun_depositERC1155Batch )
            throw new Error( strErrorOfDryRun_depositERC1155Batch );

        const joReceiptDeposit =
            await payed_call(
                details,
                ethersProvider_main_net,
                "DepositBoxERC1155", jo_deposit_box_erc1155, "depositERC1155Batch", arrArguments_depositERC1155Batch,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_deposit, weiHowMuch_depositERC1155Batch,
                null
            );
        if( joReceiptDeposit && typeof joReceiptDeposit == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_batch_payment_from_main_net/deposit",
                "receipt": joReceiptDeposit
            } );
        }

        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_main_net ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_main_net, jo_message_proxy_main_net,
                    strEventName, joReceiptDeposit.blockNumber, joReceiptDeposit.transactionHash,
                    jo_message_proxy_main_net.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_main_net.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for the \"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_main_net.address + " contract, no events found" );
        } // if( jo_message_proxy_main_net )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc1155_batch_payment_from_main_net", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-1155 PAYMENT FROM MAIN NET", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc1155_batch_payment_from_main_net", true );
    details.close();
    return true;
} // async function do_erc1155_batch_payment_from_main_net(...

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function do_erc20_payment_from_s_chain(
    ethersProvider_main_net,
    ethersProvider_s_chain,
    cid_main_net,
    cid_s_chain,
    joAccountSrc,
    joAccountDst,
    jo_token_manager_erc20, // only s-chain
    jo_message_proxy_s_chain, // for checking logs
    jo_deposit_box, // only main net
    token_amount, // how much ERC20 tokens to send
    weiHowMuch, // how much ETH
    strCoinNameErc20_main_net,
    joErc20_main_net,
    strCoinNameErc20_s_chain,
    joErc20_s_chain,
    tc_s_chain
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc20_payment_from_s_chain
    let strActionName = "";
    const strLogPrefix = cc.info( "S2M ERC20 Payment:" ) + " ";
    try {
        strActionName = "ERC20 payment from S-Chain, approve";
        const erc20ABI = joErc20_s_chain[strCoinNameErc20_s_chain + "_abi"];
        const erc20Address_s_chain = joErc20_s_chain[strCoinNameErc20_s_chain + "_address"];
        const tokenManagerAddress = jo_token_manager_erc20.address;
        const contractERC20 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc20Address_s_chain,
                erc20ABI,
                ethersProvider_s_chain
            );
        const arrArguments_approve = [
            tokenManagerAddress, owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_amount ).toHexString() )
        ];
        const erc20Address_main_net = joErc20_main_net[strCoinNameErc20_main_net + "_address"];
        const arrArguments_exitToMainERC20 = [
            erc20Address_main_net,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_amount ).toHexString() )
            // owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( weiHowMuch ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "ERC20", contractERC20, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "ERC20", contractERC20, "approve", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        let opts = {
            isCheckTransactionToSchain: true
        };
        const joReceiptApprove =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "ERC20", contractERC20, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                opts
            );
        if( joReceiptApprove && typeof joReceiptApprove == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc20_payment_from_s_chain/approve",
                "receipt": joReceiptApprove
            } );
        }
        //
        if( g_nSleepBetweenTransactionsOnSChainMilliseconds ) {
            details.write( cc.normal( "Sleeping " ) + cc.info( g_nSleepBetweenTransactionsOnSChainMilliseconds ) + cc.normal( " milliseconds between transactions..." ) + "\n" );
            await sleep( g_nSleepBetweenTransactionsOnSChainMilliseconds );
        }
        if( g_bWaitForNextBlockOnSChain )
            await safe_waitForNextBlockToAppear( details, ethersProvider_s_chain );
        //
        //
        //
        //
        strActionName = "ERC20 payment from S-Chain, exitToMainERC20";
        const weiHowMuch_exitToMainERC20 = undefined;
        const estimatedGas_exitToMainERC20 =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC20", jo_token_manager_erc20, "exitToMainERC20", arrArguments_exitToMainERC20,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_exitToMainERC20,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_exitToMainERC20 ) + "\n" );
        gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const isIgnore_exitToMainERC20 = true;
        const strErrorOfDryRun_exitToMainERC20 =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC20", jo_token_manager_erc20, "exitToMainERC20", arrArguments_exitToMainERC20,
                joAccountSrc, strActionName, isIgnore_exitToMainERC20,
                gasPrice, estimatedGas_exitToMainERC20, weiHowMuch_exitToMainERC20,
                null
            );
        if( strErrorOfDryRun_exitToMainERC20 )
            throw new Error( strErrorOfDryRun_exitToMainERC20 );

        opts.isCheckTransactionToSchain = true;
        const joReceiptExitToMainERC20 =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC20", jo_token_manager_erc20, "exitToMainERC20", arrArguments_exitToMainERC20,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_exitToMainERC20, weiHowMuch_exitToMainERC20,
                opts
            );
        if( joReceiptExitToMainERC20 && typeof joReceiptExitToMainERC20 == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc20_payment_from_s_chain/exit-to-main",
                "receipt": joReceiptExitToMainERC20
            } );
        }

        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_s_chain ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_s_chain, jo_message_proxy_s_chain,
                    strEventName, joReceiptExitToMainERC20.blockNumber, joReceiptExitToMainERC20.transactionHash,
                    jo_message_proxy_s_chain.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for the \"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_s_chain.address + " contract, no events found" );
        } // if( jo_message_proxy_s_chain )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc20_payment_from_s_chain", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-20 PAYMENT FROM S-CHAIN", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc20_payment_from_s_chain", true );
    details.close();
    return true;
} // async function do_erc20_payment_from_s_chain(...

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function do_erc721_payment_from_s_chain(
    ethersProvider_main_net,
    ethersProvider_s_chain,
    cid_main_net,
    cid_s_chain,
    joAccountSrc,
    joAccountDst,
    jo_token_manager_erc721, // only s-chain
    jo_message_proxy_s_chain, // for checking logs
    jo_deposit_box, // only main net
    token_id, // which ERC721 token id to send
    weiHowMuch, // how much ETH
    strCoinNameErc721_main_net,
    joErc721_main_net,
    strCoinNameErc721_s_chain,
    joErc721_s_chain,
    tc_s_chain
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc721_payment_from_s_chain
    let strActionName = "";
    const strLogPrefix = cc.info( "S2M ERC721 Payment:" ) + " ";
    try {
        strActionName = "ERC721 payment from S-Chain, approve";
        const erc721ABI = joErc721_s_chain[strCoinNameErc721_s_chain + "_abi"];
        const erc721Address_s_chain = joErc721_s_chain[strCoinNameErc721_s_chain + "_address"];
        const tokenManagerAddress = jo_token_manager_erc721.address;
        const contractERC721 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc721Address_s_chain,
                erc721ABI,
                ethersProvider_s_chain
            );
        const arrArguments_approve = [
            // accountForSchain,
            tokenManagerAddress,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() )
        ];
        const erc721Address_main_net = joErc721_main_net[strCoinNameErc721_main_net + "_address"];
        const arrArguments_exitToMainERC721 = [
            erc721Address_main_net,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() )
            // owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( weiHowMuch ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "ERC721", contractERC721, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(transfer from) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "ERC721", contractERC721, "approve", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        let opts = {
            isCheckTransactionToSchain: true
        };
        const joReceiptApprove =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "ERC721", contractERC721, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                opts
            );
        if( joReceiptApprove && typeof joReceiptApprove == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc721_payment_from_s_chain/transfer-from",
                "receipt": joReceiptApprove
            } );
        }

        if( g_nSleepBetweenTransactionsOnSChainMilliseconds ) {
            details.write( cc.normal( "Sleeping " ) + cc.info( g_nSleepBetweenTransactionsOnSChainMilliseconds ) + cc.normal( " milliseconds between transactions..." ) + "\n" );
            await sleep( g_nSleepBetweenTransactionsOnSChainMilliseconds );
        }
        if( g_bWaitForNextBlockOnSChain )
            await safe_waitForNextBlockToAppear( details, ethersProvider_s_chain );
        //
        //
        //
        //
        strActionName = "ERC721 payment from S-Chain, exitToMainERC721";
        const weiHowMuch_exitToMainERC721 = undefined;
        gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_exitToMainERC721 =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC721", jo_token_manager_erc721, "exitToMainERC721", arrArguments_exitToMainERC721,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_exitToMainERC721,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(exit to main) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_exitToMainERC721 ) + "\n" );
        const isIgnore_exitToMainERC721 = true;
        const strErrorOfDryRun_exitToMainERC721 =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC721", jo_token_manager_erc721, "exitToMainERC721", arrArguments_exitToMainERC721,
                joAccountSrc, strActionName, isIgnore_exitToMainERC721,
                gasPrice, estimatedGas_exitToMainERC721, weiHowMuch_exitToMainERC721,
                null
            );
        if( strErrorOfDryRun_exitToMainERC721 )
            throw new Error( strErrorOfDryRun_exitToMainERC721 );

        opts.isCheckTransactionToSchain = true;
        const joReceiptExitToMainERC721 =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC721", jo_token_manager_erc721, "exitToMainERC721", arrArguments_exitToMainERC721,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_exitToMainERC721, weiHowMuch_exitToMainERC721,
                opts
            );
        if( joReceiptExitToMainERC721 && typeof joReceiptExitToMainERC721 == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc721_payment_from_s_chain/exit-to-main",
                "receipt": joReceiptExitToMainERC721
            } );
        }

        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_s_chain ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_s_chain, jo_message_proxy_s_chain,
                    strEventName, joReceiptExitToMainERC721.blockNumber, joReceiptExitToMainERC721.transactionHash,
                    jo_message_proxy_s_chain.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for the \"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_s_chain.address + " contract, no events found" );
        } // if( jo_message_proxy_s_chain )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc721_payment_from_s_chain", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-721 PAYMENT FROM S-CHAIN", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc721_payment_from_s_chain", true );
    details.close();
    return true;
} // async function do_erc721_payment_from_s_chain(...

export async function do_erc1155_payment_from_s_chain(
    ethersProvider_main_net,
    ethersProvider_s_chain,
    cid_main_net,
    cid_s_chain,
    joAccountSrc,
    joAccountDst,
    jo_token_manager_erc1155, // only s-chain
    jo_message_proxy_s_chain, // for checking logs
    jo_deposit_box, // only main net
    token_id, // which ERC1155 token id to send
    token_amount, // which ERC1155 token id to send
    weiHowMuch, // how much ETH
    strCoinNameErc1155_main_net,
    joErc1155_main_net,
    strCoinNameErc1155_s_chain,
    joErc1155_s_chain,
    tc_s_chain
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc1155_payment_from_s_chain
    let strActionName = "";
    const strLogPrefix = cc.info( "S2M ERC1155 Payment:" ) + " ";
    try {
        strActionName = "ERC1155 payment from S-Chain, approve";
        const erc1155ABI = joErc1155_s_chain[strCoinNameErc1155_s_chain + "_abi"];
        const erc1155Address_s_chain = joErc1155_s_chain[strCoinNameErc1155_s_chain + "_address"];
        const tokenManagerAddress = jo_token_manager_erc1155.address;
        const contractERC1155 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc1155Address_s_chain,
                erc1155ABI,
                ethersProvider_s_chain
            );
        const arrArguments_approve = [
            // accountForSchain,
            tokenManagerAddress,
            true
        ];
        const erc1155Address_main_net = joErc1155_main_net[strCoinNameErc1155_main_net + "_address"];
        const arrArguments_exitToMainERC1155 = [
            erc1155Address_main_net,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() ),
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_amount ).toHexString() )
            // owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( weiHowMuch ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(transfer from) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        let opts = {
            isCheckTransactionToSchain: true
        };
        const joReceiptApprove =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                opts
            );
        if( joReceiptApprove && typeof joReceiptApprove == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_payment_from_s_chain/transfer-from",
                "receipt": joReceiptApprove
            } );
        }

        if( g_nSleepBetweenTransactionsOnSChainMilliseconds ) {
            details.write( cc.normal( "Sleeping " ) + cc.info( g_nSleepBetweenTransactionsOnSChainMilliseconds ) + cc.normal( " milliseconds between transactions..." ) + "\n" );
            await sleep( g_nSleepBetweenTransactionsOnSChainMilliseconds );
        }
        if( g_bWaitForNextBlockOnSChain )
            await safe_waitForNextBlockToAppear( details, ethersProvider_s_chain );
        //
        //
        //
        //
        strActionName = "ERC1155 payment from S-Chain, exitToMainERC1155";
        const weiHowMuch_exitToMainERC1155 = undefined;
        gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_exitToMainERC1155 =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC1155", jo_token_manager_erc1155, "exitToMainERC1155", arrArguments_exitToMainERC1155,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_exitToMainERC1155,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(exit to main) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_exitToMainERC1155 ) + "\n" );
        const isIgnore_exitToMainERC1155 = true;
        const strErrorOfDryRun_exitToMainERC1155 =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC1155", jo_token_manager_erc1155, "exitToMainERC1155", arrArguments_exitToMainERC1155,
                joAccountSrc, strActionName, isIgnore_exitToMainERC1155,
                gasPrice, estimatedGas_exitToMainERC1155, weiHowMuch_exitToMainERC1155,
                null
            );
        if( strErrorOfDryRun_exitToMainERC1155 )
            throw new Error( strErrorOfDryRun_exitToMainERC1155 );

        opts.isCheckTransactionToSchain = true;
        const joReceiptExitToMainERC1155 =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC1155", jo_token_manager_erc1155, "exitToMainERC1155", arrArguments_exitToMainERC1155,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_exitToMainERC1155, weiHowMuch_exitToMainERC1155,
                opts
            );
        if( joReceiptExitToMainERC1155 && typeof joReceiptExitToMainERC1155 == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_payment_from_s_chain/exit-to-main",
                "receipt": joReceiptExitToMainERC1155
            } );
        }

        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_s_chain ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_s_chain, jo_message_proxy_s_chain,
                    strEventName, joReceiptExitToMainERC1155.blockNumber, joReceiptExitToMainERC1155.transactionHash,
                    jo_message_proxy_s_chain.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for the \"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_s_chain.address + " contract, no events found" );
        } // if( jo_message_proxy_s_chain )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc1155_payment_from_s_chain", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-1155 PAYMENT FROM S-CHAIN", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc1155_payment_from_s_chain", true );
    details.close();
    return true;
} // async function do_erc1155_payment_from_s_chain(...

export async function do_erc1155_batch_payment_from_s_chain(
    ethersProvider_main_net,
    ethersProvider_s_chain,
    cid_main_net,
    cid_s_chain,
    joAccountSrc,
    joAccountDst,
    jo_token_manager_erc1155, // only s-chain
    jo_message_proxy_s_chain, // for checking logs
    jo_deposit_box, // only main net
    token_ids, // which ERC1155 token ids to send
    token_amounts, // which ERC1155 token amounts to send
    weiHowMuch, // how much ETH
    strCoinNameErc1155_main_net,
    joErc1155_main_net,
    strCoinNameErc1155_s_chain,
    joErc1155_s_chain,
    tc_s_chain
) {
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc1155_batch_payment_from_s_chain
    let strActionName = "";
    const strLogPrefix = cc.info( "S2M ERC1155 Batch Payment:" ) + " ";
    try {
        strActionName = "ERC1155 payment from S-Chain, approve";
        const erc1155ABI = joErc1155_s_chain[strCoinNameErc1155_s_chain + "_abi"];
        const erc1155Address_s_chain = joErc1155_s_chain[strCoinNameErc1155_s_chain + "_address"];
        const tokenManagerAddress = jo_token_manager_erc1155.address;
        const contractERC1155 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc1155Address_s_chain,
                erc1155ABI,
                ethersProvider_s_chain
            );
        const arrArguments_approve = [
            // accountForSchain,
            tokenManagerAddress,
            true
        ];
        const erc1155Address_main_net = joErc1155_main_net[strCoinNameErc1155_main_net + "_address"];
        const arrArguments_exitToMainERC1155Batch = [
            erc1155Address_main_net,
            token_ids, //owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() ),
            token_amounts //owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_amount ).toHexString() )
            // owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( weiHowMuch ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(transfer from) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        let opts = {
            isCheckTransactionToSchain: true
        };
        const joReceiptApprove =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                opts
            );
        if( joReceiptApprove && typeof joReceiptApprove == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_batch_payment_from_s_chain/transfer-from",
                "receipt": joReceiptApprove
            } );
        }

        if( g_nSleepBetweenTransactionsOnSChainMilliseconds ) {
            details.write( cc.normal( "Sleeping " ) + cc.info( g_nSleepBetweenTransactionsOnSChainMilliseconds ) + cc.normal( " milliseconds between transactions..." ) + "\n" );
            await sleep( g_nSleepBetweenTransactionsOnSChainMilliseconds );
        }
        if( g_bWaitForNextBlockOnSChain )
            await safe_waitForNextBlockToAppear( details, ethersProvider_s_chain );
        //
        //
        //
        //
        strActionName = "ERC1155 batch-payment from S-Chain, exitToMainERC1155Batch";
        const weiHowMuch_exitToMainERC1155Batch = undefined;
        gasPrice = await tc_s_chain.computeGasPrice( ethersProvider_s_chain, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_exitToMainERC1155Batch =
            await tc_s_chain.computeGas(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC1155", jo_token_manager_erc1155, "exitToMainERC1155Batch", arrArguments_exitToMainERC1155Batch,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_exitToMainERC1155Batch,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(exit to main) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_exitToMainERC1155Batch ) + "\n" );
        const isIgnore_exitToMainERC1155Batch = true;
        const strErrorOfDryRun_exitToMainERC1155Batch =
            await dry_run_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC1155", jo_token_manager_erc1155, "exitToMainERC1155Batch", arrArguments_exitToMainERC1155Batch,
                joAccountSrc, strActionName, isIgnore_exitToMainERC1155Batch,
                gasPrice, estimatedGas_exitToMainERC1155Batch, weiHowMuch_exitToMainERC1155Batch,
                null
            );
        if( strErrorOfDryRun_exitToMainERC1155Batch )
            throw new Error( strErrorOfDryRun_exitToMainERC1155Batch );

        opts.isCheckTransactionToSchain = true;
        const joReceiptExitToMainERC1155Batch =
            await payed_call(
                details,
                ethersProvider_s_chain,
                "TokenManagerERC1155", jo_token_manager_erc1155, "exitToMainERC1155Batch", arrArguments_exitToMainERC1155Batch,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_exitToMainERC1155Batch, weiHowMuch_exitToMainERC1155Batch,
                opts
            );
        if( joReceiptExitToMainERC1155Batch && typeof joReceiptExitToMainERC1155Batch == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_batch_payment_from_s_chain/exit-to-main",
                "receipt": joReceiptExitToMainERC1155Batch
            } );
        }
        //
        // Must-have event(s) analysis as indicator(s) of success
        //
        const strEventName = "OutgoingMessage";
        if( jo_message_proxy_s_chain ) {
            details.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.debug( " contract ..." ) + "\n" );
            await sleep( g_nSleepBeforeFetchOutgoingMessageEvent );
            const joEvents =
                await get_contract_call_events(
                    details, ethersProvider_s_chain, jo_message_proxy_s_chain,
                    strEventName, joReceiptExitToMainERC1155Batch.blockNumber, joReceiptExitToMainERC1155Batch.transactionHash,
                    jo_message_proxy_s_chain.filters[ strEventName ]()
                    );
            if( joEvents.length > 0 )
                details.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_s_chain.address ) + cc.success( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
            else
                throw new Error( "Verification failed for the \"OutgoingMessage\" event of the \"MessageProxy\"/" + jo_message_proxy_s_chain.address + " contract, no events found" );
        } // if( jo_message_proxy_s_chain )
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
        cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc1155_batch_payment_from_s_chain", false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-1155 PAYMENT FROM S-CHAIN", jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc1155_batch_payment_from_s_chain", true );
    details.close();
    return true;
} // async function do_erc1155_batch_payment_from_s_chain(...

//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
export async function do_erc20_payment_s2s(
    isForward,
    ethersProvider_src,
    cid_src,
    strChainName_dst,
    joAccountSrc,
    jo_token_manager_erc20_src,
    nAmountOfToken, // how much ERC20 tokens to send
    nAmountOfWei, // how much to send
    strCoinNameErc20_src,
    joErc20_src,
    erc20_address_dst, // only reverse payment needs it
    tc
) {
    const isReverse = isForward ? false : true;
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc20_payment_s2s
    let strActionName = "";
    const strLogPrefix = cc.info( "S2S ERC20 Payment(" + ( isForward ? "forward" : "reverse" ) + "):" ) + " ";
    try {
        strActionName = "validateArgs/do_erc20_payment_s2s/" + ( isForward ? "forward" : "reverse" );
        if( ! ethersProvider_src )
            throw new Error( "No ethers provider specified for source of transfer" );
        if( ! strChainName_dst )
            throw new Error( "No destination chain name provided" );
        if( ! joAccountSrc )
            throw new Error( "No account or sign TX way provided" );
        if( ! strCoinNameErc20_src )
            throw new Error( "Need full source ERC20 information, like ABI" );
        if( ! joErc20_src )
            throw new Error( "No source ERC20 ABI provided" );
        if( isReverse ) {
            if( ! erc20_address_dst )
                throw new Error( "No destination ERC20 address provided" );
        }
        if( ! tc )
            throw new Error( "No transaction customizer provided" );
        const erc20_abi_src = joErc20_src[strCoinNameErc20_src + "_abi"];
        const erc20_address_src = joErc20_src[strCoinNameErc20_src + "_address"];
        details.write( strLogPrefix + cc.attention( "Token Manager ERC20" ) + cc.debug( " address on source chain...." ) + cc.note( jo_token_manager_erc20_src.address ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Source ERC20" ) + cc.debug( " coin name........................." ) + cc.note( strCoinNameErc20_src ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Source ERC20" ) + cc.debug( " token address....................." ) + cc.note( erc20_address_src ) + "\n" );
        if( isReverse || erc20_address_dst )
            details.write( strLogPrefix + cc.attention( "Destination ERC20" ) + cc.debug( " token address................" ) + cc.note( erc20_address_dst ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Destination chain name" ) + cc.debug( "........................." ) + cc.note( strChainName_dst ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Amount of tokens" ) + cc.debug( " to transfer..................." ) + cc.note( nAmountOfToken ) + "\n" );
        //
        strActionName = "ERC20 payment S2S, approve, " + ( isForward ? "forward" : "reverse" );
        const contractERC20 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc20_address_src,
                erc20_abi_src,
                ethersProvider_src
            );
        const arrArguments_approve = [
            jo_token_manager_erc20_src.address,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( nAmountOfToken ).toHexString() )
        ];
        const arrArguments_transfer = [
            strChainName_dst,
            isReverse ? erc20_address_dst : erc20_address_src,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( nAmountOfToken ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc.computeGasPrice( ethersProvider_src, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc.computeGas(
                details,
                ethersProvider_src,
                "ERC20", contractERC20, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_src,
                "ERC20", contractERC20, "approve", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        const joReceipt_approve =
            await payed_call(
                details,
                ethersProvider_src,
                "ERC20", contractERC20, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( joReceipt_approve && typeof joReceipt_approve == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc20_payment_s2s/approve/" + ( isForward ? "forward" : "reverse" ),
                "receipt": joReceipt_approve
            } );
        }

        strActionName = "ERC20 payment S2S, transferERC20 " + ( isForward ? "forward" : "reverse" );
        const weiHowMuch_transferERC20 = undefined;
        gasPrice = await tc.computeGasPrice( ethersProvider_src, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_transfer =
            await tc.computeGas(
                details,
                ethersProvider_src,
                "TokenManagerERC20", jo_token_manager_erc20_src, "transferToSchainERC20", arrArguments_transfer,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_transferERC20,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(transfer) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_transfer ) + "\n" );
        const isIgnore_transferERC20 = true;
        const strErrorOfDryRun_transferERC20 =
            await dry_run_call(
                details,
                ethersProvider_src,
                "TokenManagerERC20", jo_token_manager_erc20_src, "transferToSchainERC20", arrArguments_transfer,
                joAccountSrc, strActionName, isIgnore_transferERC20,
                gasPrice, estimatedGas_transfer, weiHowMuch_transferERC20,
                null
            );
        if( strErrorOfDryRun_transferERC20 )
            throw new Error( strErrorOfDryRun_transferERC20 );

        const joReceipt_transfer =
            await payed_call(
                details,
                ethersProvider_src,
                "TokenManagerERC20", jo_token_manager_erc20_src, "transferToSchainERC20", arrArguments_transfer,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_transfer, weiHowMuch_transferERC20,
                null
            );
        if( joReceipt_transfer && typeof joReceipt_transfer == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc20_payment_from_src/transfer",
                "receipt": joReceipt_transfer
            } );
        }
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc20_payment_s2s/" + ( isForward ? "forward" : "reverse" ), false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-20 PAYMENT FROM S2S/" + ( isForward ? "forward" : "reverse" ), jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc20_payment_s2s/" + ( isForward ? "forward" : "reverse" ), true );
    details.close();
    return true;
}

//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//

export async function do_erc721_payment_s2s(
    isForward,
    ethersProvider_src,
    cid_src,
    strChainName_dst,
    joAccountSrc,
    jo_token_manager_erc721_src,
    token_id, // which ERC721 token id to send
    nAmountOfWei, // how much to send
    strCoinNameErc721_src,
    joErc721_src,
    erc721_address_dst, // only reverse payment needs it
    tc
) {
    const isReverse = isForward ? false : true;
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc721_payment_s2s
    let strActionName = "";
    const strLogPrefix = cc.info( "S2S ERC721 Payment(" + ( isForward ? "forward" : "reverse" ) + "):" ) + " ";
    try {
        strActionName = "validateArgs/do_erc721_payment_s2s/" + ( isForward ? "forward" : "reverse" );
        if( ! ethersProvider_src )
            throw new Error( "No provider for source of transfer" );
        if( ! strChainName_dst )
            throw new Error( "No destination chain name provided" );
        if( ! joAccountSrc )
            throw new Error( "No account or sign TX way provided" );
        if( ! strCoinNameErc721_src )
            throw new Error( "Need full source ERC721 information, like ABI" );
        if( ! joErc721_src )
            throw new Error( "No source ERC721 ABI provided" );
        if( isReverse ) {
            if( ! erc721_address_dst )
                throw new Error( "No destination ERC721 address provided" );
        }
        if( ! tc )
            throw new Error( "No transaction customizer provided" );
        const erc721_abi_src = joErc721_src[strCoinNameErc721_src + "_abi"];
        const erc721_address_src = joErc721_src[strCoinNameErc721_src + "_address"];
        details.write( strLogPrefix + cc.attention( "Token Manager ERC721" ) + cc.debug( " address on source chain...." ) + cc.note( jo_token_manager_erc721_src.address ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Source ERC721" ) + cc.debug( " coin name........................." ) + cc.note( strCoinNameErc721_src ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Source ERC721" ) + cc.debug( " token address....................." ) + cc.note( erc721_address_src ) + "\n" );
        if( isReverse || erc721_address_dst )
            details.write( strLogPrefix + cc.attention( "Destination ERC721" ) + cc.debug( " token address................" ) + cc.note( erc721_address_dst ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Destination chain name" ) + cc.debug( "........................." ) + cc.note( strChainName_dst ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Token ID" ) + cc.debug( " to transfer..........................." ) + cc.note( token_id ) + "\n" );

        strActionName = "ERC721 payment S2S, approve, " + ( isForward ? "forward" : "reverse" );
        const contractERC721 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc721_address_src,
                erc721_abi_src,
                ethersProvider_src
            );
        const arrArguments_approve = [
            jo_token_manager_erc721_src.address,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() )
        ];
        const arrArguments_transfer = [
            strChainName_dst,
            isReverse ? erc721_address_dst : erc721_address_src,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc.computeGasPrice( ethersProvider_src, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc.computeGas(
                details,
                ethersProvider_src,
                "ERC721", contractERC721, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_src,
                "ERC721", contractERC721, "approve", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        const joReceipt_approve =
            await payed_call(
                details,
                ethersProvider_src,
                "ERC721", contractERC721, "approve", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( joReceipt_approve && typeof joReceipt_approve == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc721_payment_s2s/approve/" + ( isForward ? "forward" : "reverse" ),
                "receipt": joReceipt_approve
            } );
        }

        strActionName = "ERC721 payment S2S, transferERC721 " + ( isForward ? "forward" : "reverse" );
        const weiHowMuch_transferERC721 = undefined;
        gasPrice = await tc.computeGasPrice( ethersProvider_src, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_transfer =
            await tc.computeGas(
                details,
                ethersProvider_src,
                "TokenManagerERC721", jo_token_manager_erc721_src, "transferToSchainERC721", arrArguments_transfer,
                joAccountSrc, strActionName, isIgnore_transferERC721,
                gasPrice, 8000000, weiHowMuch_transferERC721,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(transfer) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_transfer ) + "\n" );
        const isIgnore_transferERC721 = true;
        const strErrorOfDryRun_transferERC721 =
            await dry_run_call(
                details,
                ethersProvider_src,
                "TokenManagerERC721", jo_token_manager_erc721_src, "transferToSchainERC721", arrArguments_transfer,
                joAccountSrc, strActionName, isIgnore_transferERC721,
                gasPrice, estimatedGas_transfer, weiHowMuch_transferERC721,
                null
            );
        if( strErrorOfDryRun_transferERC721 )
            throw new Error( strErrorOfDryRun_transferERC721 );

        const joReceipt_transfer =
            await payed_call(
                details,
                ethersProvider_src,
                "TokenManagerERC721", jo_token_manager_erc721_src, "transferToSchainERC721", arrArguments_transfer,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_transfer, weiHowMuch_transferERC721,
                null
            );
        if( joReceipt_transfer && typeof joReceipt_transfer == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc721_payment_from_src/transfer",
                "receipt": joReceipt_transfer
            } );
        }
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc721_payment_s2s/" + ( isForward ? "forward" : "reverse" ), false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-721 PAYMENT FROM S2S/" + ( isForward ? "forward" : "reverse" ), jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc721_payment_s2s/" + ( isForward ? "forward" : "reverse" ), true );
    details.close();
    return true;
}

//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
export async function do_erc1155_payment_s2s(
    isForward,
    ethersProvider_src,
    cid_src,
    strChainName_dst,
    joAccountSrc,
    jo_token_manager_erc1155_src,
    token_id, // which ERC721 token id to send
    nAmountOfToken, // how much ERC1155 tokens to send
    nAmountOfWei, // how much to send
    strCoinNameErc1155_src,
    joErc1155_src,
    erc1155_address_dst, // only reverse payment needs it
    tc
) {
    const isReverse = isForward ? false : true;
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc1155_payment_s2s
    let strActionName = "";
    const strLogPrefix = cc.info( "S2S ERC1155 Payment(" + ( isForward ? "forward" : "reverse" ) + "):" ) + " ";
    try {
        strActionName = "validateArgs/do_erc1155_payment_s2s/" + ( isForward ? "forward" : "reverse" );
        if( ! ethersProvider_src )
            throw new Error( "No provider for source of transfer" );
        if( ! strChainName_dst )
            throw new Error( "No destination chain name provided" );
        if( ! joAccountSrc )
            throw new Error( "No account or sign TX way provided" );
        if( ! strCoinNameErc1155_src )
            throw new Error( "Need full source ERC1155 information, like ABI" );
        if( ! joErc1155_src )
            throw new Error( "No source ERC1155 ABI provided" );
        if( isReverse ) {
            if( ! erc1155_address_dst )
                throw new Error( "No destination ERC1155 address provided" );
        }
        if( ! tc )
            throw new Error( "No transaction customizer provided" );
        const erc1155_abi_src = joErc1155_src[strCoinNameErc1155_src + "_abi"];
        const erc1155_address_src = joErc1155_src[strCoinNameErc1155_src + "_address"];
        details.write( strLogPrefix + cc.attention( "Token Manager ERC1155" ) + cc.debug( " address on source chain...." ) + cc.note( jo_token_manager_erc1155_src.address ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Source ERC1155" ) + cc.debug( " coin name........................." ) + cc.note( strCoinNameErc1155_src ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Source ERC1155" ) + cc.debug( " token address....................." ) + cc.note( erc1155_address_src ) + "\n" );
        if( isReverse || erc1155_address_dst )
            details.write( strLogPrefix + cc.attention( "Destination ERC1155" ) + cc.debug( " token address................" ) + cc.note( erc1155_address_dst ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Destination chain name" ) + cc.debug( "........................." ) + cc.note( strChainName_dst ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Token ID" ) + cc.debug( " to transfer..........................." ) + cc.note( token_id ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Amount of tokens" ) + cc.debug( " to transfer..................." ) + cc.note( nAmountOfToken ) + "\n" );

        strActionName = "ERC1155 payment S2S, approve, " + ( isForward ? "forward" : "reverse" );
        const contractERC1155 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc1155_address_src,
                erc1155_abi_src,
                ethersProvider_src
            );
        const arrArguments_approve = [
            jo_token_manager_erc1155_src.address,
            true
        ];
        const arrArguments_transfer = [
            strChainName_dst,
            isReverse ? erc1155_address_dst : erc1155_address_src,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( token_id ).toHexString() ),
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( nAmountOfToken ).toHexString() )
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc.computeGasPrice( ethersProvider_src, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc.computeGas(
                details,
                ethersProvider_src,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_src,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        const joReceipt_approve =
            await payed_call(
                details,
                ethersProvider_src,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( joReceipt_approve && typeof joReceipt_approve == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_payment_s2s/approve/" + ( isForward ? "forward" : "reverse" ),
                "receipt": joReceipt_approve
            } );
        }

        strActionName = "ERC1155 payment S2S, transferERC1155 " + ( isForward ? "forward" : "reverse" );
        const weiHowMuch_transferERC1155 = undefined;
        gasPrice = await tc.computeGasPrice( ethersProvider_src, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_transfer =
            await tc.computeGas(
                details,
                ethersProvider_src,
                "TokenManagerERC1155", jo_token_manager_erc1155_src, "transferToSchainERC1155", arrArguments_transfer,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_transferERC1155,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(transfer) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_transfer ) + "\n" );
        const isIgnore_transferERC1155 = true;
        const strErrorOfDryRun_transferERC1155 =
            await dry_run_call(
                details,
                ethersProvider_src,
                "TokenManagerERC1155", jo_token_manager_erc1155_src, "transferToSchainERC1155", arrArguments_transfer,
                joAccountSrc, strActionName, isIgnore_transferERC1155,
                gasPrice, estimatedGas_transfer, weiHowMuch_transferERC1155,
                null
            );
        if( strErrorOfDryRun_transferERC1155 )
            throw new Error( strErrorOfDryRun_transferERC1155 );

        const joReceipt_transfer =
            await payed_call(
                details,
                ethersProvider_src,
                "TokenManagerERC1155", jo_token_manager_erc1155_src, "transferToSchainERC1155", arrArguments_transfer,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_transfer, weiHowMuch_transferERC1155,
                null
            );
        if( joReceipt_transfer && typeof joReceipt_transfer == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_payment_from_src/transfer",
                "receipt": joReceipt_transfer
            } );
        }
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc1155_payment_s2s/" + ( isForward ? "forward" : "reverse" ), false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-1155 PAYMENT FROM S2S/" + ( isForward ? "forward" : "reverse" ), jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc1155_payment_s2s/" + ( isForward ? "forward" : "reverse" ), true );
    details.close();
    return true;
}

//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
export async function do_erc1155_batch_payment_s2s(
    isForward,
    ethersProvider_src,
    cid_src,
    strChainName_dst,
    joAccountSrc,
    jo_token_manager_erc1155_src,
    token_ids, // which ERC1155 token id to send
    token_amounts, // which ERC1155 token id to send
    nAmountOfWei, // how much to send
    strCoinNameErc1155_src,
    joErc1155_src,
    erc1155_address_dst, // only reverse payment needs it
    tc
) {
    const isReverse = isForward ? false : true;
    const details = log.createMemoryStream();
    const jarrReceipts = []; // do_erc1155_batch_payment_s2s
    let strActionName = "";
    const strLogPrefix = cc.info( "S2S Batch ERC1155 Payment(" + ( isForward ? "forward" : "reverse" ) + "):" ) + " ";
    try {
        strActionName = "validateArgs/do_erc1155_batch_payment_s2s/" + ( isForward ? "forward" : "reverse" );
        if( ! ethersProvider_src )
            throw new Error( "No provider for source of transfer" );
        if( ! strChainName_dst )
            throw new Error( "No destination chain name provided" );
        if( ! joAccountSrc )
            throw new Error( "No account or sign TX way provided" );
        if( ! strCoinNameErc1155_src )
            throw new Error( "Need full source ERC1155 information, like ABI" );
        if( ! joErc1155_src )
            throw new Error( "No source ERC1155 ABI provided" );
        if( isReverse ) {
            if( ! erc1155_address_dst )
                throw new Error( "No destination ERC1155 address provided" );
        }
        if( ! tc )
            throw new Error( "No transaction customizer provided" );
        const erc1155_abi_src = joErc1155_src[strCoinNameErc1155_src + "_abi"];
        const erc1155_address_src = joErc1155_src[strCoinNameErc1155_src + "_address"];
        details.write( strLogPrefix + cc.attention( "Token Manager ERC1155" ) + cc.debug( " address on source chain...." ) + cc.note( jo_token_manager_erc1155_src.address ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Source ERC1155" ) + cc.debug( " coin name........................." ) + cc.note( strCoinNameErc1155_src ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Source ERC1155" ) + cc.debug( " token address....................." ) + cc.note( erc1155_address_src ) + "\n" );
        if( isReverse || erc1155_address_dst )
            details.write( strLogPrefix + cc.attention( "Destination ERC1155" ) + cc.debug( " token address................" ) + cc.note( erc1155_address_dst ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Destination chain name" ) + cc.debug( "........................." ) + cc.note( strChainName_dst ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Token IDs" ) + cc.debug( " to transfer.........................." ) + cc.j( token_ids ) + "\n" );
        details.write( strLogPrefix + cc.attention( "Amounts of tokens" ) + cc.debug( " to transfer.................." ) + cc.j( token_amounts ) + "\n" );

        strActionName = "ERC1155 batch-payment S2S, approve, " + ( isForward ? "forward" : "reverse" );
        const contractERC1155 =
            new owaspUtils.ethersMod.ethers.Contract(
                erc1155_address_src,
                erc1155_abi_src,
                ethersProvider_src
            );
        const arrArguments_approve = [
            jo_token_manager_erc1155_src.address,
            true
        ];
        const arrArguments_transfer = [
            strChainName_dst,
            isReverse ? erc1155_address_dst : erc1155_address_src,
            token_ids,
            token_amounts
        ];
        const weiHowMuch_approve = undefined;
        let gasPrice = await tc.computeGasPrice( ethersProvider_src, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_approve =
            await tc.computeGas(
                details,
                ethersProvider_src,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_approve,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(approve) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_approve ) + "\n" );
        const isIgnore_approve = false;
        const strErrorOfDryRun_approve =
            await dry_run_call(
                details,
                ethersProvider_src,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName, isIgnore_approve,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( strErrorOfDryRun_approve )
            throw new Error( strErrorOfDryRun_approve );

        const joReceipt_approve =
            await payed_call(
                details,
                ethersProvider_src,
                "ERC1155", contractERC1155, "setApprovalForAll", arrArguments_approve,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_approve, weiHowMuch_approve,
                null
            );
        if( joReceipt_approve && typeof joReceipt_approve == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_batch_payment_s2s/approve/" + ( isForward ? "forward" : "reverse" ),
                "receipt": joReceipt_approve
            } );
        }

        strActionName = "ERC1155 batch-payment S2S, transferERC1155 " + ( isForward ? "forward" : "reverse" );
        const weiHowMuch_transferERC1155 = undefined;
        gasPrice = await tc.computeGasPrice( ethersProvider_src, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_transfer =
            await tc.computeGas(
                details,
                ethersProvider_src,
                "TokenManagerERC1155", jo_token_manager_erc1155_src, "transferToSchainERC1155Batch", arrArguments_transfer,
                joAccountSrc, strActionName,
                gasPrice, 8000000, weiHowMuch_transferERC1155,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated(transfer) " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_transfer ) + "\n" );
        const isIgnore_transferERC1155 = true;
        const strErrorOfDryRun_transferERC1155 =
            await dry_run_call(
                details,
                ethersProvider_src,
                "TokenManagerERC1155", jo_token_manager_erc1155_src, "transferToSchainERC1155Batch", arrArguments_transfer,
                joAccountSrc, strActionName, isIgnore_transferERC1155,
                gasPrice, estimatedGas_transfer, weiHowMuch_transferERC1155,
                null
            );
        if( strErrorOfDryRun_transferERC1155 )
            throw new Error( strErrorOfDryRun_transferERC1155 );

        const joReceipt_transfer =
            await payed_call(
                details,
                ethersProvider_src,
                "TokenManagerERC1155", jo_token_manager_erc1155_src, "transferToSchainERC1155Batch", arrArguments_transfer,
                joAccountSrc, strActionName,
                gasPrice, estimatedGas_transfer, weiHowMuch_transferERC1155,
                null
            );
        if( joReceipt_transfer && typeof joReceipt_transfer == "object" ) {
            jarrReceipts.push( {
                "description": "do_erc1155_payment_from_src/transfer",
                "receipt": joReceipt_transfer
            } );
        }
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Payment error in " + strActionName + ": " ) + cc.error( strError ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( s );
        details.write( s );
        details.exposeDetailsTo( log, "do_erc1155_batch_payment_s2s/" + ( isForward ? "forward" : "reverse" ), false );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "ERC-1155-batch PAYMENT FROM S2S/" + ( isForward ? "forward" : "reverse" ), jarrReceipts );
    if( expose_details_get() )
        details.exposeDetailsTo( log, "do_erc1155_batch_payment_s2s/" + ( isForward ? "forward" : "reverse" ), true );
    details.close();
    return true;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

async function find_out_reference_log_record( details, ethersProvider, jo_message_proxy, nBlockId, nMessageNumberToFind, isVerbose ) {
    const strLogPrefix = "";
    const bnMessageNumberToFind = owaspUtils.toBN( nMessageNumberToFind.toString() );
    const strEventName = "PreviousMessageReference";
    const arrLogRecords =
        await safe_getPastEventsProgressive(
            details,
            ethersProvider,
            10,
            jo_message_proxy,
            strEventName,
            nBlockId, // nBlockFrom
            nBlockId, // nBlockTo
            jo_message_proxy.filters[ strEventName ]()
            );
    const cntLogRecord = arrLogRecords.length;
    if( isVerbose ) {
        details.write( strLogPrefix +
            cc.debug( "Got " ) + cc.info( cntLogRecord ) + cc.debug( " log record(s) (" ) + cc.info( strEventName ) +
            cc.debug( ") with data: " ) + cc.j( arrLogRecords ) + "\n" );
    }
    for( let idxLogRecord = 0; idxLogRecord < cntLogRecord; ++ idxLogRecord ) {
        const joEvent = arrLogRecords[idxLogRecord];
        const eventValuesByName = {
            currentMessage: joEvent.args[0],
            previousOutgoingMessageBlockId: joEvent.args[1]
        };
        const joReferenceLogRecord = {
            currentMessage: eventValuesByName.currentMessage,
            previousOutgoingMessageBlockId: eventValuesByName.previousOutgoingMessageBlockId,
            currentBlockId: owaspUtils.toInteger( nBlockId.toString() ) // added field
        };
        const bnCurrentMessage = owaspUtils.toBN( joReferenceLogRecord.currentMessage.toString() );
        if( bnCurrentMessage.eq( bnMessageNumberToFind ) ) {
            if( isVerbose ) {
                details.write( strLogPrefix +
                    cc.success( "Found " ) + cc.info( strEventName ) + cc.success( " log record " ) +
                    cc.j( joReferenceLogRecord ) + cc.success( " for message " ) + cc.info( nMessageNumberToFind ) + "\n" );
            }
            return joReferenceLogRecord;
        }
    } // for( let idxLogRecord = 0; idxLogRecord < cntLogRecord; ++ idxLogRecord )
    if( isVerbose ) {
        details.write( strLogPrefix +
            cc.error( "Failed to find " ) + cc.info( strEventName ) + cc.error( " log record for message " ) +
            cc.info( nMessageNumberToFind ) + "\n" );
    }
    return null;
}

async function find_out_all_reference_log_records( details, ethersProvider, jo_message_proxy, nBlockId, nIncMsgCnt, nOutMsgCnt, isVerbose ) {
    const strLogPrefix = "";
    if( isVerbose ) {
        details.write( strLogPrefix +
            cc.debug( "Optimized IMA message search algorithm will start at block " ) + cc.info( nBlockId.toString() ) +
            cc.debug( ", will search for outgoing message counter " ) + cc.info( nOutMsgCnt.toString() ) +
            cc.debug( " and approach down to incoming message counter " ) + cc.info( nIncMsgCnt.toString() ) +
            "\n" );
    }
    const arrLogRecordReferences = [];
    const cntExpected = nOutMsgCnt - nIncMsgCnt;
    if( cntExpected <= 0 ) {
        if( isVerbose ) {
            details.write( strLogPrefix +
                cc.success( "Optimized IMA message search algorithm success, nothing to search, result is empty" ) + "\n" );
        }
        return arrLogRecordReferences; // nothing to search
    }
    let nWalkMsgNumber = nOutMsgCnt - 1;
    let nWalkBlockId = nBlockId;
    for( ; nWalkMsgNumber >= nIncMsgCnt; -- nWalkMsgNumber ) {
        const joReferenceLogRecord =
            await find_out_reference_log_record(
                details, ethersProvider, jo_message_proxy,
                nWalkBlockId, nWalkMsgNumber,
                isVerbose
                );
        if( joReferenceLogRecord == null )
            break;
        nWalkBlockId = owaspUtils.toInteger( joReferenceLogRecord.previousOutgoingMessageBlockId.toString() );
        arrLogRecordReferences.unshift( joReferenceLogRecord );
    } // for( ; nWalkMsgNumber >= nIncMsgCnt; -- nWalkMsgNumber )
    const cntFound = arrLogRecordReferences.length;
    if( cntFound != cntExpected ) {
        if( isVerbose ) {
            details.write( strLogPrefix +
                cc.error( "Optimized IMA message search algorithm fail, found " ) + cc.info( cntFound ) +
                cc.error( " log record(s), expected " ) + cc.info( cntExpected ) + cc.error( " log record(s), found records are: " ) +
                cc.j( arrLogRecordReferences ) + "\n" );
        }
    } else {
        if( isVerbose ) {
            details.write( strLogPrefix +
                cc.success( "Optimized IMA message search algorithm success, found all " ) +
                cc.info( cntFound ) + cc.success( " log record(s): " ) + cc.j( arrLogRecordReferences ) + "\n" );
        }
    }
    return arrLogRecordReferences;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

let g_nTransferLoopCounter = 0;

//
// Do real money movement from main-net to S-chain by sniffing events
// 1) main-net.MessageProxyForMainnet.getOutgoingMessagesCounter -> save to nOutMsgCnt
// 2) S-chain.MessageProxySchain.getIncomingMessagesCounter -> save to nIncMsgCnt
// 3) Will transfer all in range from [ nIncMsgCnt ... (nOutMsgCnt-1) ] ... assume current counter index is nIdxCurrentMsg
//
// One transaction transfer is:
// 1) Find events main-net.MessageProxyForMainnet.OutgoingMessage where msgCounter member is in range
// 2) Publish it to S-chain.MessageProxySchain.postIncomingMessages(
//            main-net chain id   // uint64 srcChainID
//            nIdxCurrentMsg // uint64 startingCounter
//            [srcContract]  // address[] memory senders
//            [dstContract]  // address[] memory dstContracts
//            [to]           // address[] memory to
//            [amount]       // uint256[] memory amount / *uint256[2] memory blsSignature* /
//            )
//
export async function do_transfer(
    strDirection,
    joRuntimeOpts,
    //
    ethersProvider_src,
    jo_message_proxy_src,
    joAccountSrc,
    ethersProvider_dst,
    jo_message_proxy_dst,
    //
    joAccountDst,
    //
    chain_id_src,
    chain_id_dst,
    cid_src,
    cid_dst,
    //
    jo_deposit_box_main_net, // for logs validation on mainnet
    jo_token_manager_schain, // for logs validation on s-chain
    //
    nTransactionsCountInBlock,
    nTransferSteps,
    nMaxTransactionsCount,
    nBlockAwaitDepth,
    nBlockAge,
    fn_sign_messages,
    joExtraSignOpts,
    //
    tc_dst
) {
    const imaState = state.get();
    const nTransferLoopCounter = g_nTransferLoopCounter;
    ++ g_nTransferLoopCounter;
    //
    const strTransferErrorCategoryName = "loop-" + strDirection;
    const strGatheredDetailsName_a = "" + strDirection + "-" +
        "do_transfer-A-#" + nTransferLoopCounter +
        "-" + chain_id_src + "-->" + chain_id_dst;
    const strGatheredDetailsName_a_colored = "" + cc.bright( strDirection ) + cc.debug( "-" ) +
        cc.info( "do_transfer-A-" ) + cc.debug( "-" ) + cc.notice( "#" ) + cc.note( nTransferLoopCounter ) +
        cc.debug( "-" ) + cc.notice( chain_id_src ) + cc.debug( "-->" ) + cc.notice( chain_id_dst );
    const details = log.createMemoryStream( true );
    const jarrReceipts = [];
    let bErrorInSigningMessages = false;
    const strLogPrefix = cc.bright( strDirection ) + cc.info( " transfer from " ) + cc.notice( chain_id_src ) + cc.info( " to " ) + cc.notice( chain_id_dst ) + cc.info( ":" ) + " ";
    if( fn_sign_messages == null || fn_sign_messages == undefined ) {
        details.write( strLogPrefix + cc.debug( "Using internal signing stub function" ) + "\n" );
        fn_sign_messages = async function( jarrMessages, nIdxCurrentMsgBlockStart, details, joExtraSignOpts, fnAfter ) {
            details.write( strLogPrefix + cc.debug( "Message signing callback was " ) + cc.error( "not provided" ) +
                cc.debug( " to IMA, first real message index is:" ) + cc.info( nIdxCurrentMsgBlockStart ) +
                cc.debug( ", have " ) + cc.info( jarrMessages.length ) + cc.debug( " message(s) to process:" ) + cc.j( jarrMessages ) +
                "\n" );
            await fnAfter( null, jarrMessages, null ); // null - no error, null - no signatures
        };
    } else
        details.write( strLogPrefix + cc.debug( "Using externally provided signing function" ) + "\n" );
    nTransactionsCountInBlock = nTransactionsCountInBlock || 5;
    nTransferSteps = nTransferSteps || Number.MAX_SAFE_INTEGER;
    let nStepsDone = 0;
    nMaxTransactionsCount = nMaxTransactionsCount || Number.MAX_SAFE_INTEGER;
    if( nTransactionsCountInBlock < 1 )
        nTransactionsCountInBlock = 1;
    if( nBlockAwaitDepth < 0 )
        nBlockAwaitDepth = 0;
    if( nBlockAge < 0 )
        nBlockAge = 0;
    let r; let strActionName = "";
    let nIdxCurrentMsg = 0;
    let nOutMsgCnt = 0;
    let nIncMsgCnt = 0;
    try {
        let nPossibleIntegerValue = 0;
        details.write( cc.info( "SRC " ) + cc.sunny( "MessageProxy" ) + cc.info( " address is....." ) + cc.bright( jo_message_proxy_src.address ) + "\n" );
        details.write( cc.info( "DST " ) + cc.sunny( "MessageProxy" ) + cc.info( " address is....." ) + cc.bright( jo_message_proxy_dst.address ) + "\n" );
        strActionName = "src-chain.MessageProxy.getOutgoingMessagesCounter()";
        try {
            details.write( strLogPrefix + cc.debug( "Will call " ) + cc.notice( strActionName ) + cc.debug( "..." ) + "\n" );
            nPossibleIntegerValue = await jo_message_proxy_src.callStatic.getOutgoingMessagesCounter( chain_id_dst, { from: joAccountSrc.address() } );
            if( !owaspUtils.validateInteger( nPossibleIntegerValue ) )
                throw new Error( "DST chain " + chain_id_dst + " returned outgoing message counter " + nPossibleIntegerValue + " which is not a valid integer" );
            nOutMsgCnt = owaspUtils.toInteger( nPossibleIntegerValue );
            details.write( strLogPrefix + cc.debug( "Result of " ) + cc.notice( strActionName ) + cc.debug( " call: " ) + cc.info( nOutMsgCnt ) + "\n" );
        } catch ( err ) {
            log.write( cc.fatal( "IMMEDIATE ERROR LOG:" ) +
                cc.error( " error caught during " ) + cc.attention( strActionName ) +
                cc.error( ", error details: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
                cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                "\n"
            );
        }
        //
        strActionName = "dst-chain.MessageProxy.getIncomingMessagesCounter()";
        details.write( strLogPrefix + cc.debug( "Will call " ) + cc.notice( strActionName ) + cc.debug( "..." ) + "\n" );
        nPossibleIntegerValue = await jo_message_proxy_dst.callStatic.getIncomingMessagesCounter( chain_id_src, { from: joAccountDst.address() } );
        if( !owaspUtils.validateInteger( nPossibleIntegerValue ) )
            throw new Error( "SRC chain " + chain_id_src + " returned incoming message counter " + nPossibleIntegerValue + " which is not a valid integer" );
        nIncMsgCnt = owaspUtils.toInteger( nPossibleIntegerValue );
        details.write( strLogPrefix + cc.debug( "Result of " ) + cc.notice( strActionName ) + cc.debug( " call: " ) + cc.info( nIncMsgCnt ) + "\n" );
        //
        strActionName = "src-chain.MessageProxy.getIncomingMessagesCounter()";
        nPossibleIntegerValue = await jo_message_proxy_src.callStatic.getIncomingMessagesCounter( chain_id_dst, { from: joAccountSrc.address() } );
        if( !owaspUtils.validateInteger( nPossibleIntegerValue ) )
            throw new Error( "DST chain " + chain_id_dst + " returned incoming message counter " + nPossibleIntegerValue + " which is not a valid integer" );
        const idxLastToPopNotIncluding = owaspUtils.toInteger( nPossibleIntegerValue );
        details.write( strLogPrefix + cc.debug( "Result of " ) + cc.notice( strActionName ) + cc.debug( " call: " ) + cc.info( idxLastToPopNotIncluding ) + "\n" );

        //
        // optimized scanner
        //
        const nBlockId = await jo_message_proxy_src.callStatic.getLastOutgoingMessageBlockId( chain_id_dst, { from: joAccountSrc.address() } );
        // const joReferenceLogRecord = await find_out_reference_log_record( details, ethersProvider_src, jo_message_proxy_src, nBlockId, nOutMsgCnt - 1, true );
        let arrLogRecordReferences = [];
        try {
            arrLogRecordReferences = await find_out_all_reference_log_records( details, ethersProvider_src, jo_message_proxy_src, nBlockId, nIncMsgCnt, nOutMsgCnt, true );
            if( arrLogRecordReferences.length <= 0 )
                throw new Error( "Nothing was found by optimized IMA messages search algorithm" );
        } catch ( err ) {
            arrLogRecordReferences = [];
            details.write(
                strLogPrefix + cc.warning( "Optimized log search is " ) + cc.error( "off" ) +
                cc.warning( ". Running old IMA smart contracts?" ) + cc.success( " Please upgrade, if possible." ) +
                cc.warning( " This message is based on error: " ) + cc.success( " Please upgrade, if possible." ) +
                "\n" );
        }

        //
        // classic scanner with optional usage of optimized IMA messages search algorithm
        // outer loop is block former/creator, then transfer
        //
        nIdxCurrentMsg = nIncMsgCnt;
        let cntProcessed = 0;
        while( nIdxCurrentMsg < nOutMsgCnt ) {
            if( nStepsDone > nTransferSteps ) {
                if( verbose_get() >= RV_VERBOSE().information ) {
                    log.write(
                        strLogPrefix + cc.error( "WARNING:" ) + " " +
                        cc.warning( "Transfer step count overflow" ) +
                        "\n" );
                }
                details.close();
                save_transfer_success_all();
                return false;
            }
            details.write(
                strLogPrefix + cc.debug( "Entering block former iteration with " ) + cc.notice( "message counter" ) +
                cc.debug( " set to " ) + cc.info( nIdxCurrentMsg ) +
                cc.debug( ", transfer step number is " ) + cc.info( nStepsDone ) +
                cc.debug( ", can transfer up to " ) + cc.info( nMaxTransactionsCount ) + cc.debug( " message(s) per step" ) +
                cc.debug( ", can perform up to " ) + cc.info( nTransferSteps ) + cc.debug( " transfer step(s)" ) +
                "\n" );
            if( ! loop.check_time_framing( null, strDirection, joRuntimeOpts ) ) {
                if( verbose_get() >= RV_VERBOSE().information ) {
                    log.write(
                        strLogPrefix + cc.error( "WARNING:" ) + " " +
                        cc.warning( "Time framing overflow (after entering block former iteration loop)" ) +
                        "\n" );
                }
                details.close();
                save_transfer_success_all();
                return false;
            }
            const arrMessageCounters = [];
            const jarrMessages = [];
            const nIdxCurrentMsgBlockStart = 0 + nIdxCurrentMsg;
            //
            // inner loop wil create block of transactions
            //
            let cntAccumulatedForBlock = 0;
            for( let idxInBlock = 0; nIdxCurrentMsg < nOutMsgCnt && idxInBlock < nTransactionsCountInBlock; ++nIdxCurrentMsg, ++idxInBlock, ++cntAccumulatedForBlock ) {
                const idxProcessing = cntProcessed + idxInBlock;
                if( idxProcessing > nMaxTransactionsCount )
                    break;
                //
                let nBlockFrom = 0;
                let nBlockTo = "latest";
                if( arrLogRecordReferences.length > 0 ) {
                    const joReferenceLogRecord = arrLogRecordReferences.shift();
                    nBlockFrom = joReferenceLogRecord.currentBlockId;
                    nBlockTo = joReferenceLogRecord.currentBlockId;
                }
                //
                strActionName = "src-chain->MessageProxy->scan-past-events()";
                const strEventName = "OutgoingMessage";
                details.write(
                    strLogPrefix + cc.debug( "Will call " ) + cc.notice( strActionName ) +
                    cc.debug( " for " ) + cc.info( strEventName ) + cc.debug( " event..." ) +
                    "\n" );
                r = await safe_getPastEventsProgressive(
                    details,
                    ethersProvider_src,
                    10,
                    jo_message_proxy_src,
                    strEventName,
                    nBlockFrom,
                    nBlockTo,
                    jo_message_proxy_src.filters[ strEventName ](
                        owaspUtils.ethersMod.ethers.utils.id( chain_id_dst ), // dstChainHash
                        nIdxCurrentMsg // msgCounter
                    )
                );
                //details.write( strLogPrefix + cc.normal( "Logs search result(s): " ) + cc.j( r ) + "\n" );
                const strChainHashWeAreLookingFor = owaspUtils.ethersMod.ethers.utils.id( chain_id_dst );
                let joValues = "";
                details.write( strLogPrefix +
                    cc.debug( "Will review " ) + cc.info( r.length ) +
                    cc.debug( " found event records(in reverse order, newest to oldest)" ) +
                    cc.debug( " while looking for hash " ) + cc.info( strChainHashWeAreLookingFor ) +
                    cc.debug( " of destination chain " ) + cc.info( chain_id_dst ) +
                    "\n" );
                for( let i = r.length - 1; i >= 0; i-- ) {
                    const joEvent = r[i];
                    details.write( strLogPrefix +
                        cc.debug( "Will review found event record " ) + cc.info( i ) +
                        cc.debug( " with data " ) + cc.j( joEvent ) +
                        "\n" );
                    const eventValuesByName = {
                        dstChainHash: joEvent.args[0],
                        msgCounter: joEvent.args[1],
                        srcContract: joEvent.args[2],
                        dstContract: joEvent.args[3],
                        data: joEvent.args[4]
                    };
                    if( eventValuesByName.dstChainHash == strChainHashWeAreLookingFor ) {
                        joValues = eventValuesByName;
                        joValues.savedBlockNumberForOptimizations = r[i].blockNumber;
                        details.write( strLogPrefix +
                            cc.debug( "Found event record " ) + cc.info( i ) + cc.debug( " reviewed and " ) +
                            cc.success( "accepted for processing, found event values are " ) + cc.j( joValues ) +
                            cc.success( ", found block number is " ) + cc.info( joValues.savedBlockNumberForOptimizations ) +
                            "\n" );
                        break;
                    } else {
                        details.write( strLogPrefix +
                            cc.debug( "Found event record " ) + cc.info( i ) + cc.debug( " reviewed and " ) +
                            cc.warning( "skipped" ) +
                            "\n" );
                    }
                }
                if( joValues == "" ) {
                    const strError = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + " " + cc.error( "Can't get events from MessageProxy" );
                    log.write( strError + "\n" );
                    details.write( strError + "\n" );
                    details.exposeDetailsTo( log, strGatheredDetailsName_a, false );
                    save_transfer_error( strTransferErrorCategoryName, details.toString() );
                    details.close();
                    return false;
                }
                //
                //
                //
                if( nBlockAwaitDepth > 0 ) {
                    let bSecurityCheckPassed = true;
                    const strActionName_old = "" + strActionName;
                    strActionName = "security check: evaluate block depth";
                    try {
                        const transactionHash = r[0].transactionHash;
                        details.write( strLogPrefix + cc.debug( "Event transactionHash is " ) + cc.info( transactionHash ) + "\n" );
                        const blockNumber = r[0].blockNumber;
                        details.write( strLogPrefix + cc.debug( "Event blockNumber is " ) + cc.info( blockNumber ) + "\n" );
                        const nLatestBlockNumber = await safe_getBlockNumber( details, 10, ethersProvider_src );
                        details.write( strLogPrefix + cc.debug( "Latest blockNumber is " ) + cc.info( nLatestBlockNumber ) + "\n" );
                        const nDist = nLatestBlockNumber - blockNumber;
                        if( nDist < nBlockAwaitDepth )
                            bSecurityCheckPassed = false;
                        details.write( strLogPrefix + cc.debug( "Distance by blockNumber is " ) + cc.info( nDist ) + cc.debug( ", await check is " ) + ( bSecurityCheckPassed ? cc.success( "PASSED" ) : cc.error( "FAILED" ) ) + "\n" );
                    } catch ( err ) {
                        bSecurityCheckPassed = false;
                        const strError = owaspUtils.extract_error_message( err );
                        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) +
                             cc.error( " Exception(evaluate block depth) while getting transaction hash and block number during " +
                            strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
                        if( verbose_get() >= RV_VERBOSE().fatal )
                            log.write( s );
                        details.write( s );
                        details.exposeDetailsTo( log, strGatheredDetailsName_a, false );
                        save_transfer_error( strTransferErrorCategoryName, details.toString() );
                        details.close();
                        return false;
                    }
                    strActionName = "" + strActionName_old;
                    if( !bSecurityCheckPassed ) {
                        const s = strLogPrefix + cc.warning( "Block depth check was not passed, canceling search for transfer events" ) + "\n";
                        if( verbose_get() >= RV_VERBOSE().debug )
                            log.write( s );
                        details.write( s );
                        break;
                    }
                } // if( nBlockAwaitDepth > 0 )
                if( nBlockAge > 0 ) {
                    let bSecurityCheckPassed = true;
                    const strActionName_old = "" + strActionName;
                    strActionName = "security check: evaluate block age";
                    try {
                        const transactionHash = r[0].transactionHash;
                        details.write( strLogPrefix + cc.debug( "Event transactionHash is " ) + cc.info( transactionHash ) + "\n" );
                        const blockNumber = r[0].blockNumber;
                        details.write( strLogPrefix + cc.debug( "Event blockNumber is " ) + cc.info( blockNumber ) + "\n" );
                        //
                        //
                        const joBlock = await ethersProvider_src.getBlock( blockNumber );
                        if( !owaspUtils.validateInteger( joBlock.timestamp ) )
                            throw new Error( "Block \"timestamp\" is not a valid integer value: " + joBlock.timestamp );
                        const timestampBlock = owaspUtils.toInteger( joBlock.timestamp );
                        details.write( strLogPrefix + cc.debug( "Block   TS is " ) + cc.info( timestampBlock ) + "\n" );
                        const timestampCurrent = current_timestamp();
                        details.write( strLogPrefix + cc.debug( "Current TS is " ) + cc.info( timestampCurrent ) + "\n" );
                        const tsDiff = timestampCurrent - timestampBlock;
                        details.write( strLogPrefix + cc.debug( "Diff    TS is " ) + cc.info( tsDiff ) + "\n" );
                        details.write( strLogPrefix + cc.debug( "Expected diff " ) + cc.info( nBlockAge ) + "\n" );
                        if( tsDiff < nBlockAge )
                            bSecurityCheckPassed = false;
                        details.write( strLogPrefix + cc.debug( "Block age check is " ) + ( bSecurityCheckPassed ? cc.success( "PASSED" ) : cc.error( "FAILED" ) ) + "\n" );
                    } catch ( err ) {
                        bSecurityCheckPassed = false;
                        const strError = owaspUtils.extract_error_message( err );
                        const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) +
                            cc.error( " Exception(evaluate block age) while getting block number and timestamp during " +
                            strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n";
                        if( verbose_get() >= RV_VERBOSE().fatal )
                            log.write( s );
                        details.write( s );
                        details.exposeDetailsTo( log, strGatheredDetailsName_a, false );
                        save_transfer_error( strTransferErrorCategoryName, details.toString() );
                        details.close();
                        return false;
                    }
                    strActionName = "" + strActionName_old;
                    if( !bSecurityCheckPassed ) {
                        details.write( strLogPrefix + cc.warning( "Block age check was not passed, canceling search for transfer events" ) + "\n" );
                        break;
                    }
                } // if( nBlockAge > 0 )
                //
                //
                //
                details.write(
                    strLogPrefix +
                    cc.success( "Got event details from " ) + cc.notice( "getPastEvents()" ) +
                    cc.success( " event invoked with " ) + cc.notice( "msgCounter" ) + cc.success( " set to " ) + cc.info( nIdxCurrentMsg ) +
                    cc.success( " and " ) + cc.notice( "dstChain" ) + cc.success( " set to " ) + cc.info( chain_id_dst ) +
                    cc.success( ", event description: " ) + cc.j( joValues ) + // + cc.j(evs) +
                    "\n"
                );
                //
                //
                details.write( strLogPrefix + cc.debug( "Will process message counter value " ) + cc.info( nIdxCurrentMsg ) + "\n" );
                arrMessageCounters.push( nIdxCurrentMsg );

                const joMessage = {
                    sender: joValues.srcContract,
                    destinationContract: joValues.dstContract,
                    to: joValues.to,
                    amount: joValues.amount,
                    data: joValues.data,
                    savedBlockNumberForOptimizations: joValues.savedBlockNumberForOptimizations
                };
                jarrMessages.push( joMessage );
            } // for( let idxInBlock = 0; nIdxCurrentMsg < nOutMsgCnt && idxInBlock < nTransactionsCountInBlock; ++ nIdxCurrentMsg, ++ idxInBlock, ++cntAccumulatedForBlock )
            if( cntAccumulatedForBlock == 0 )
                break;
            if( ! loop.check_time_framing( null, strDirection, joRuntimeOpts ) ) {
                if( verbose_get() >= RV_VERBOSE().information ) {
                    log.write(
                        strLogPrefix + cc.error( "WARNING:" ) + " " +
                        cc.warning( "Time framing overflow (after forming block of messages)" ) +
                        "\n" );
                }
                details.close();
                save_transfer_success_all();
                return false;
            }
            //
            //
            //
            if( strDirection == "S2S" ) {
                strActionName = "S2S message analysis";
                if( ! joExtraSignOpts )
                    throw new Error( "Could not validate S2S messages, no extra options provided to transfer algorithm" );
                if( ! joExtraSignOpts.skale_observer )
                    throw new Error( "Could not validate S2S messages, no SKALE NETWORK observer provided to transfer algorithm" );
                const arr_schains_cached = joExtraSignOpts.skale_observer.get_last_cached_schains();
                if( ( !arr_schains_cached ) || arr_schains_cached.length == 0 )
                    throw new Error( "Could not validate S2S messages, no S-Chains in SKALE NETWORK observer cached yet, try again later" );
                const idxSChain = joExtraSignOpts.skale_observer.find_schain_index_in_array_by_name( arr_schains_cached, chain_id_src );
                if( idxSChain < 0 ) {
                    throw new Error(
                        "Could not validate S2S messages, source S-Chain \"" + chain_id_src +
                        "\" is not in SKALE NETWORK observer cache yet or it's not connected to this \"" + chain_id_dst +
                        "\" S-Chain yet, try again later" );
                }
                const cntMessages = jarrMessages.length;
                const jo_schain = arr_schains_cached[idxSChain];
                const cntNodes = jo_schain.data.computed.nodes.length;
                const cntNodesShouldPass =
                    ( cntNodes == 16 )
                        ? 11
                        : (
                            ( cntNodes == 4 )
                                ? 3
                                : (
                                    ( cntNodes == 2 || cntNodes == 1 )
                                        ? ( 0 + cntNodes )
                                        : parseInt( ( cntNodes * 2 ) / 3 )
                                )
                        );
                const cntNodesMayFail = cntNodes - cntNodesShouldPass;
                details.write( strLogPrefix +
                    cc.sunny( strDirection ) + cc.debug( " message analysis will be performed o S-Chain " ) +
                    cc.info( chain_id_src ) + cc.debug( " with " ) +
                    cc.info( cntNodes ) + cc.debug( " node(s), " ) +
                    cc.info( cntNodesShouldPass ) + cc.debug( " node(s) should have same message(s), " ) +
                    cc.info( cntNodesMayFail ) + cc.debug( " node(s) allowed to fail message(s) comparison, " ) +
                    cc.info( cntMessages ) + cc.debug( " message(s) to check..." ) +
                    "\n" );

                // jarrMessages.push( {
                //     sender: joValues.srcContract,
                //     destinationContract: joValues.dstContract,
                //     to: joValues.to,
                //     amount: joValues.amount,
                //     data: joValues.data
                // } );
                for( let idxMessage = 0; idxMessage < cntMessages; ++ idxMessage ) {
                    const idxImaMessage = arrMessageCounters[idxMessage];
                    const joMessage = jarrMessages[idxMessage];
                    details.write( strLogPrefix +
                        cc.sunny( strDirection ) + cc.debug( " message analysis for message " ) +
                        cc.info( idxMessage + 1 ) + cc.debug( " of " ) + cc.info( cntMessages ) +
                        cc.debug( " with IMA message index " ) + cc.j( idxImaMessage ) +
                        cc.debug( " and message envelope data:" ) + cc.j( joMessage ) +
                        "\n" );
                    let cntPassedNodes = 0, cntFailedNodes = 0;
                    try {
                        for( let idxNode = 0; idxNode < cntNodes; ++ idxNode ) {
                            const jo_node = jo_schain.data.computed.nodes[idxNode];
                            details.write( strLogPrefix +
                                cc.debug( "Validating " ) + cc.sunny( strDirection ) + cc.debug( " message " ) + cc.info( idxMessage + 1 ) +
                                cc.debug( " on node " ) + cc.info( jo_node.name ) +
                                cc.debug( " using URL " ) + cc.info( jo_node.http_endpoint_ip ) +
                                cc.debug( "..." ) + "\n" );
                            try {
                                const ethersProvider_node = owaspUtils.getEthersProviderFromURL( jo_node.http_endpoint_ip );
                                const jo_message_proxy_node =
                                    new owaspUtils.ethersMod.ethers.Contract(
                                        imaState.chainProperties.sc.joAbiIMA.message_proxy_chain_address,
                                        imaState.chainProperties.sc.joAbiIMA.message_proxy_chain_abi,
                                        ethersProvider_node
                                    );
                                const strEventName = "OutgoingMessage";
                                const node_r = await safe_getPastEventsProgressive(
                                    details,
                                    ethersProvider_node,
                                    10,
                                    jo_message_proxy_node,
                                    strEventName,
                                    joMessage.savedBlockNumberForOptimizations, // 0, // nBlockFrom
                                    joMessage.savedBlockNumberForOptimizations, // "latest", // nBlockTo
                                    jo_message_proxy_node.filters[strEventName](
                                        owaspUtils.ethersMod.ethers.utils.id( chain_id_dst ), // dstChainHash
                                        idxImaMessage // msgCounter
                                    )
                                );
                                const cntEvents = node_r.length;
                                details.write( strLogPrefix +
                                    cc.debug( "Got " ) + cc.info( cntEvents ) + cc.debug( " event(s) (" ) + cc.info( strEventName ) + cc.debug( ") on node " ) +
                                    cc.info( jo_node.name ) + cc.debug( " with data: " ) + cc.j( node_r ) + "\n" );
                                for( let idxEvent = 0; idxEvent < cntEvents; ++ idxEvent ) {
                                    const joEvent = node_r[idxEvent];
                                    const eventValuesByName = {
                                        dstChainHash: joEvent.args[0],
                                        msgCounter: joEvent.args[1],
                                        srcContract: joEvent.args[2],
                                        dstContract: joEvent.args[3],
                                        data: joEvent.args[4]
                                    };
                                        if( owaspUtils.ensure_starts_with_0x( joMessage.sender ).toLowerCase() ==
                                        owaspUtils.ensure_starts_with_0x( eventValuesByName.srcContract ).toLowerCase() &&
                                        owaspUtils.ensure_starts_with_0x( joMessage.destinationContract ).toLowerCase() ==
                                        owaspUtils.ensure_starts_with_0x( eventValuesByName.dstContract ).toLowerCase()
                                    )
                                        bEventIsFound = true;
                                    if( bEventIsFound )
                                        break;
                                } // for( let idxEvent = 0; idxEvent < cntEvents; ++ idxEvent )
                            } catch ( err ) {
                                ++ cntFailedNodes;
                                const strError = strLogPrefix + cc.fatal( strDirection + " message analysis error:" ) + " " +
                                    cc.error( "Failed to scan events on node " ) + cc.info( jo_node.name ) +
                                    cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
                                    cc.error( ", detailed node description is: " ) + cc.j( jo_node ) +
                                    cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                                    "\n";
                                details.write( strError );
                                if( verbose_get() >= RV_VERBOSE().fatal )
                                    log.write( strError );
                                // details.exposeDetailsTo( log, strGatheredDetailsName_a, false );
                                // save_transfer_error( strTransferErrorCategoryName, details.toString() );
                                // details.close();
                                // return false;
                                continue;
                            }
                            if( bEventIsFound ) {
                                ++ cntPassedNodes;
                                details.write( strLogPrefix + cc.sunny( strDirection ) +
                                    cc.success( " message " ) + cc.info( idxMessage + 1 ) + cc.success( " validation on node " ) +
                                    cc.info( jo_node.name ) + cc.success( " using URL " ) + cc.info( jo_node.http_endpoint_ip ) +
                                    cc.success( " is passed" ) + "\n" );
                            } else {
                                ++ cntFailedNodes;
                                const strError = strLogPrefix + cc.sunny( strDirection ) +
                                    cc.error( " message " ) + cc.info( idxMessage + 1 ) + cc.error( " validation on node " ) +
                                    cc.info( jo_node.name ) + cc.success( " using URL " ) + cc.info( jo_node.http_endpoint_ip ) +
                                    cc.error( " is failed" ) + "\n"; ;
                                details.write( strError );
                                if( verbose_get() >= RV_VERBOSE().fatal )
                                    log.write( strError );
                            }
                            if( cntFailedNodes > cntNodesMayFail )
                                break;
                            if( cntPassedNodes >= cntNodesShouldPass ) {
                                details.write( strLogPrefix + cc.sunny( strDirection ) +
                                cc.success( " message " ) + cc.info( idxMessage + 1 ) + cc.success( " validation on node " ) +
                                cc.info( jo_node.name ) + cc.success( " using URL " ) + cc.info( jo_node.http_endpoint_ip ) +
                                cc.success( " is passed" ) + "\n" );
                                break;
                            }
                        } // for( let idxNode = 0; idxNode < cntNodes; ++ idxNode )
                    } catch ( err ) {
                        const strError = strLogPrefix + cc.fatal( strDirection + " message analysis error:" ) + " " +
                            cc.error( "Failed to process events for " ) + cc.sunny( strDirection ) + cc.error( " message " ) +
                            cc.info( idxMessage + 1 ) + cc.error( " on node " ) + cc.info( jo_node.name ) +
                            cc.error( " using URL " ) + cc.info( jo_node.http_endpoint_ip ) +
                            cc.error( ", error is: " ) + cc.warning( owaspUtils.extract_error_message( err ) ) +
                            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                            "\n";
                        details.write( strError );
                        if( verbose_get() >= RV_VERBOSE().fatal )
                            log.write( strError );
                    }
                    if( cntFailedNodes > cntNodesMayFail ) {
                        const s =
                            strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error validating " ) + cc.sunny( strDirection ) +
                            cc.error( " messages, failed node count " ) + cc.info( cntFailedNodes ) +
                            cc.error( " is greater then allowed to fail " ) + cc.info( cntNodesMayFail ) +
                            "\n";
                        if( verbose_get() >= RV_VERBOSE().fatal )
                            log.write( s );
                        details.write( s );
                        details.exposeDetailsTo( log, strGatheredDetailsName_a, false );
                        save_transfer_error( strTransferErrorCategoryName, details.toString() );
                        details.close();
                        return false;
                    }
                    if( ! ( cntPassedNodes >= cntNodesShouldPass ) ) {
                        const s =
                            strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error validating " ) + cc.sunny( strDirection ) +
                            cc.error( " messages, passed node count " ) + cc.info( cntFailedNodes ) +
                            cc.error( " is less then needed count " ) + cc.info( cntNodesShouldPass ) +
                            "\n";
                        if( verbose_get() >= RV_VERBOSE().fatal )
                            log.write( s );
                        details.write( s );
                        details.exposeDetailsTo( log, strGatheredDetailsName_a, false );
                        save_transfer_error( strTransferErrorCategoryName, details.toString() );
                        details.close();
                        return false;
                    }
                } // for( let idxMessage = 0; idxMessage < cntMessages; ++ idxMessage )

            } // if( strDirection == "S2S" ) //// "S2S message analysis
            //
            //
            //
            strActionName = "sign messages";
            details.write( strLogPrefix +
                cc.debug( "Will invoke message signing callback, first real message index is: " ) +
                cc.info( nIdxCurrentMsgBlockStart ) + cc.info( jarrMessages.length ) +
                cc.debug( " message(s) to process: " ) + cc.j( jarrMessages ) +
                "\n" );
            log.write( strLogPrefix +
                cc.debug( "Will invoke message signing callback, first real message index is: " ) +
                cc.info( nIdxCurrentMsgBlockStart ) + cc.info( jarrMessages.length ) +
                cc.debug( " message(s) to process: " ) + cc.j( jarrMessages ) +
                "\n" );
            let detailsB = log.createMemoryStream( true );
            const strGatheredDetailsName_b = "" + strDirection + "-" +
                "do_transfer-B-#" + nTransferLoopCounter +
                "-" + chain_id_src + "-->" + chain_id_dst;
            try {
                await fn_sign_messages(
                    nTransferLoopCounter,
                    jarrMessages, nIdxCurrentMsgBlockStart, chain_id_src,
                    joExtraSignOpts,
                    async function( err, jarrMessages, joGlueResult ) {
                        detailsB.write( strLogPrefix +
                            cc.debug( "Did invoked message signing callback, first real message index is: " ) +
                            cc.info( nIdxCurrentMsgBlockStart ) + cc.info( jarrMessages.length ) +
                            cc.debug( " message(s) to process: " ) + cc.j( jarrMessages ) +
                            "\n" );
                        log.write( strLogPrefix + cc.debug( "Did invoked message signing callback, " ) + cc.info( jarrMessages.length ) + cc.debug( " message(s) to process" ) + "\n" );
                        if( err ) {
                            bErrorInSigningMessages = true;
                            const strError = owaspUtils.extract_error_message( err );
                            const s = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error signing messages: " ) + cc.error( strError ) + "\n";
                            if( verbose_get() >= RV_VERBOSE().fatal )
                                log.write( s );
                            detailsB.write( s );
                            detailsB.exposeDetailsTo( log, strGatheredDetailsName_b, false );
                            save_transfer_error( strTransferErrorCategoryName, detailsB.toString() );
                            detailsB.close();
                            return false;
                        }
                        if( ! loop.check_time_framing( null, strDirection, joRuntimeOpts ) ) {
                            if( verbose_get() >= RV_VERBOSE().information )
                                log.write( strLogPrefix + cc.error( "WARNING:" ) + " " + cc.warning( "Time framing overflow (after signing messages)" ) + "\n" );
                            detailsB.close();
                            save_transfer_success_all();
                            return false;
                        }

                        //
                        const nBlockSize = arrMessageCounters.length;
                        strActionName = "dst-chain.MessageProxy.postIncomingMessages()";
                        detailsB.write( strLogPrefix +
                            cc.debug( "Will call " ) + cc.notice( strActionName ) + cc.debug( " for " ) +
                            cc.notice( "block size" ) + cc.debug( " set to " ) + cc.info( nBlockSize ) +
                            cc.debug( ", " ) + cc.notice( "message counters =" ) + cc.debug( " are " ) + cc.info( JSON.stringify( arrMessageCounters ) ) +
                            cc.debug( "..." ) + "\n"
                        );
                        log.write( strLogPrefix + cc.debug( "Will call " ) + cc.notice( strActionName ) + cc.debug( " for " ) + "\n" );
                        //
                        //
                        let signature = joGlueResult ? joGlueResult.signature : null;
                        if( !signature )
                            signature = { X: "0", Y: "0" };
                        let hashPoint = joGlueResult ? joGlueResult.hashPoint : null;
                        if( !hashPoint )
                            hashPoint = { X: "0", Y: "0" };
                        let hint = joGlueResult ? joGlueResult.hint : null;
                        if( !hint )
                            hint = "0";
                        const sign = {
                            blsSignature: [ signature.X, signature.Y ], // BLS glue of signatures
                            hashA: hashPoint.X, // G1.X from joGlueResult.hashSrc
                            hashB: hashPoint.Y, // G1.Y from joGlueResult.hashSrc
                            counter: hint
                        };

                        const arrArguments_postIncomingMessages = [
                            chain_id_src,
                            nIdxCurrentMsgBlockStart,
                            jarrMessages,
                            sign //, // bls signature components
                            // idxLastToPopNotIncluding
                        ];
                        if( verbose_get() >= RV_VERBOSE().debug ) {
                            const joDebugArgs = [
                                chain_id_src,
                                chain_id_dst,
                                nIdxCurrentMsgBlockStart,
                                jarrMessages,
                                [ signature.X, signature.Y ], // BLS glue of signatures
                                hashPoint.X, // G1.X from joGlueResult.hashSrc
                                hashPoint.Y, // G1.Y from joGlueResult.hashSrc
                                hint
                            ];
                            detailsB.write( strLogPrefix +
                                cc.debug( "....debug args for " ) +
                                cc.notice( "msgCounter" ) + cc.debug( " set to " ) + cc.info( nIdxCurrentMsgBlockStart ) + cc.debug( ": " ) +
                                cc.j( joDebugArgs ) + "\n" );
                        }
                        strActionName = strDirection + " - Post incoming messages";
                        const weiHowMuch_postIncomingMessages = undefined;
                        const gasPrice = await tc_dst.computeGasPrice( ethersProvider_dst, 200000000000 );
                        detailsB.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
                        let estimatedGas_postIncomingMessages =
                            await tc_dst.computeGas(
                                detailsB,
                                ethersProvider_dst,
                                "MessageProxy", jo_message_proxy_dst, "postIncomingMessages", arrArguments_postIncomingMessages,
                                joAccountDst, strActionName,
                                gasPrice, 10000000, weiHowMuch_postIncomingMessages,
                                null
                            );
                        detailsB.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_postIncomingMessages ) + "\n" );
                        if( strDirection == "S2M" ) {
                            const expectedGasLimit = perMessageGasForTransfer * jarrMessages.length + additionalS2MTransferOverhead;
                            estimatedGas_postIncomingMessages = Math.max( estimatedGas_postIncomingMessages, expectedGasLimit );
                        }
                        const isIgnore_postIncomingMessages = false;
                        const strErrorOfDryRun =
                            await dry_run_call(
                                detailsB,
                                ethersProvider_dst,
                                "MessageProxy", jo_message_proxy_dst, "postIncomingMessages", arrArguments_postIncomingMessages,
                                joAccountDst, strActionName, isIgnore_postIncomingMessages,
                                gasPrice, estimatedGas_postIncomingMessages, weiHowMuch_postIncomingMessages,
                                null
                            );
                        if( strErrorOfDryRun )
                            throw new Error( strErrorOfDryRun );

                        let opts = {
                            isCheckTransactionToSchain: ( chain_id_dst !== "Mainnet" ) ? true : false
                        };
                        const joReceipt =
                            await payed_call(
                                detailsB,
                                ethersProvider_dst,
                                "MessageProxy", jo_message_proxy_dst, "postIncomingMessages", arrArguments_postIncomingMessages,
                                joAccountDst, strActionName,
                                gasPrice, estimatedGas_postIncomingMessages, weiHowMuch_postIncomingMessages,
                                opts
                            );
                        if( joReceipt && typeof joReceipt == "object" ) {
                            jarrReceipts.push( {
                                "description": "do_transfer/postIncomingMessages()",
                                "detailsString": "" + strGatheredDetailsName_b,
                                "receipt": joReceipt
                            } );
                            print_gas_usage_report_from_array( "(intermediate result) TRANSFER " + chain_id_src + " -> " + chain_id_dst, jarrReceipts );
                        }
                        cntProcessed += cntAccumulatedForBlock;
                        //
                        //
                        //
                        //
                        //
                        //
                        //
                        detailsB.write( strLogPrefix + cc.debug( "Validating transfer from " ) + cc.info( chain_id_src ) + cc.debug( " to " ) + cc.info( chain_id_dst ) + cc.debug( "..." ) + "\n" );
                        //
                        // check DepositBox -> Error on Mainnet only
                        //
                        if( chain_id_dst == "Mainnet" ) {
                            detailsB.write( strLogPrefix + cc.debug( "Validating transfer to Main Net via MessageProxy error absence on Main Net..." ) + "\n" );
                            if( jo_deposit_box_main_net ) {
                                if( joReceipt && "blockNumber" in joReceipt && "transactionHash" in joReceipt ) {
                                    const strEventName = "PostMessageError";
                                    detailsB.write( strLogPrefix + cc.debug( "Verifying the " ) + cc.info( strEventName ) + cc.debug( " event of the " ) + cc.info( "MessageProxy" ) + cc.debug( "/" ) + cc.notice( jo_message_proxy_dst.address ) + cc.debug( " contract..." ) + "\n" );
                                    const joEvents =
                                        await get_contract_call_events(
                                            detailsB, ethersProvider_dst, jo_message_proxy_dst,
                                            strEventName, joReceipt.blockNumber, joReceipt.transactionHash,
                                            jo_message_proxy_dst.filters[ strEventName ]()
                                            );
                                    if( joEvents.length == 0 )
                                        detailsB.write( strLogPrefix + cc.success( "Success, verified the " ) + cc.info( strEventName ) + cc.success( " event of the " ) + cc.info( "MessageProxy" ) + cc.success( "/" ) + cc.notice( jo_message_proxy_dst.address ) + cc.success( " contract, no events found" ) + "\n" );
                                    else {
                                        log.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.warning( " Failed" ) + cc.error( " verification of the " ) + cc.warning( "PostMessageError" ) + cc.error( " event of the " ) + cc.warning( "MessageProxy" ) + cc.error( "/" ) + cc.notice( jo_message_proxy_dst.address ) + cc.error( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
                                        detailsB.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.warning( " Failed" ) + cc.error( " verification of the " ) + cc.warning( "PostMessageError" ) + cc.error( " event of the " ) + cc.warning( "MessageProxy" ) + cc.error( "/" ) + cc.notice( jo_message_proxy_dst.address ) + cc.error( " contract, found event(s): " ) + cc.j( joEvents ) + "\n" );
                                        save_transfer_error( strTransferErrorCategoryName, detailsB.toString() );
                                        throw new Error( "Verification failed for the \"PostMessageError\" event of the \"MessageProxy\"/" + jo_message_proxy_dst.address + " contract, error events found" );
                                    }
                                    detailsB.write( strLogPrefix + cc.success( "Done, validated transfer to Main Net via MessageProxy error absence on Main Net" ) + "\n" );
                                } else
                                    detailsB.write( strLogPrefix + cc.error( "WARNING:" ) + " " + cc.warn( "Cannot validate transfer to Main Net via MessageProxy error absence on Main Net, no valid transaction receipt provided" ) + "\n" );
                            } else
                                detailsB.write( strLogPrefix + cc.error( "WARNING:" ) + " " + cc.warn( "Cannot validate transfer to Main Net via MessageProxy error absence on Main Net, no MessageProxy provided" ) + "\n" );
                        } // if( chain_id_dst == "Mainnet" )

                    } ).catch( ( err ) => { // callback fn as argument of fn_sign_messages
                    bErrorInSigningMessages = true;
                    if( verbose_get() >= RV_VERBOSE().fatal ) {
                        const strError = owaspUtils.extract_error_message( err );
                        const strErrorMessage = strLogPrefix + cc.error( "Problem in transfer handler: " ) + cc.warning( strError );
                        log.write( strErrorMessage + "\n" );
                        detailsB.write( strErrorMessage + "\n" );
                        detailsB.exposeDetailsTo( log, strGatheredDetailsName_b, false );
                        save_transfer_error( strTransferErrorCategoryName, detailsB.toString() );
                        detailsB.close();
                        detailsB = null;
                    }
                    if( detailsB ) {
                        if( expose_details_get() )
                            detailsB.exposeDetailsTo( log, strGatheredDetailsName_b, true );
                        detailsB.close();
                    }
                } ); // fn_sign_messages
            } catch ( err ) {
                const strError =
                    strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) +
                    cc.error( " Exception from signing messages function: " ) + cc.error( owaspUtils.extract_error_message( err ) +
                    cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                    "\n" );
                log.write( strError );
                details.write( strError );
                if( detailsB )
                    detailsB.write( strError );
            }
            if( detailsB ) {
                if( expose_details_get() )
                    detailsB.exposeDetailsTo( log, strGatheredDetailsName_b, true );
                detailsB.close();
            }
            if( bErrorInSigningMessages )
                break;
            ++ nStepsDone;
        } // while( nIdxCurrentMsg < nOutMsgCnt )
    } catch ( err ) {
        const strError = strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) +
            cc.error( " Error in " ) + strGatheredDetailsName_a_colored +
            cc.error( " during " + strActionName + ": " ) + cc.error( owaspUtils.extract_error_message( err ) ) +
            cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
            "\n";
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strError );
        details.write( strError );
        details.exposeDetailsTo( log, strGatheredDetailsName_a, false );
        save_transfer_error( strTransferErrorCategoryName, details.toString() );
        details.close();
        return false;
    }
    print_gas_usage_report_from_array( "TRANSFER " + chain_id_src + " -> " + chain_id_dst, jarrReceipts );
    if( details ) {
        if( expose_details_get() && details.exposeDetailsTo )
            details.exposeDetailsTo( log, strGatheredDetailsName_a, true );
        details.close();
    }
    if( ! bErrorInSigningMessages )
        save_transfer_success( strTransferErrorCategoryName );
    return true;
} // async function do_transfer( ...

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function do_s2s_all( // s-chain --> s-chain
    joRuntimeOpts,
    imaState,
    skale_observer,
    ethersProvider_dst,
    jo_message_proxy_dst,
    joAccountDst,
    chain_id_dst,
    cid_dst,
    jo_token_manager_schain, // for logs validation on s-chain
    //
    nTransactionsCountInBlock,
    nTransferSteps,
    nMaxTransactionsCount,
    nBlockAwaitDepth,
    nBlockAge,
    fn_sign_messages,
    //
    tc_dst
) {
    let cntOK = 0, cntFail = 0, nIndexS2S = 0;
    const strDirection = "S2S";
    const arr_schains_cached = skale_observer.get_last_cached_schains();
    const cntSChains = arr_schains_cached.length;
    for( let idxSChain = 0; idxSChain < cntSChains; ++ idxSChain ) {
        const jo_schain = arr_schains_cached[idxSChain];
        const url_src = skale_observer.pick_random_schain_url( jo_schain );
        const ethersProvider_src = owaspUtils.getEthersProviderFromURL( url_src );
        const joAccountSrc = joAccountDst; // ???
        const chain_id_src = "" + jo_schain.data.name;
        const cid_src = "" + jo_schain.data.computed.chainId;
        let bOK = false;
        try {
            nIndexS2S = idxSChain;
            if( ! await pwa.check_on_loop_start( imaState, "s2s", nIndexS2S ) ) {
                imaState.loopState.s2s.wasInProgress = false;
                if( IMA.verbose_get() >= IMA.RV_VERBOSE().debug )
                    log.write( strLogPrefix + cc.warning( "Skipped due to cancel mode reported from PWA" ) + "\n" );
            } else {
            // ??? assuming all S-Chains have same ABIs here
                const jo_message_proxy_src =
                    new owaspUtils.ethersMod.ethers.Contract(
                        imaState.chainProperties.sc.joAbiIMA.message_proxy_chain_address,
                        imaState.chainProperties.sc.joAbiIMA.message_proxy_chain_abi,
                        ethersProvider_src
                    );
                const jo_deposit_box_src =
                    new owaspUtils.ethersMod.ethers.Contract(
                        imaState.chainProperties.sc.joAbiIMA.message_proxy_chain_address,
                        imaState.chainProperties.sc.joAbiIMA.message_proxy_chain_abi,
                        ethersProvider_src
                    );
                const joExtraSignOpts = {
                    skale_observer: skale_observer,
                    chain_id_src: chain_id_src,
                    cid_src: cid_src,
                    chain_id_dst: chain_id_dst,
                    cid_dst: cid_dst,
                    joAccountSrc: joAccountSrc,
                    joAccountDst: joAccountDst,
                    ethersProvider_src: ethersProvider_src,
                    ethersProvider_dst: ethersProvider_dst
                };
                joRuntimeOpts.idxChainKnownForS2S = idxSChain;
                joRuntimeOpts.cntChainsKnownForS2S = cntSChains;
                joRuntimeOpts.joExtraSignOpts = joExtraSignOpts;
                //
                imaState.loopState.s2s.isInProgress = true;
                await pwa.notify_on_loop_start( imaState, "s2s", nIndexS2S );
                //
                bOK =
                await do_transfer(
                    strDirection,
                    joRuntimeOpts,
                    //
                    ethersProvider_src,
                    jo_message_proxy_src,
                    joAccountSrc,
                    ethersProvider_dst,
                    jo_message_proxy_dst,
                    //
                    joAccountDst,
                    //
                    chain_id_src,
                    chain_id_dst,
                    cid_src,
                    cid_dst,
                    //
                    jo_deposit_box_src, // for logs validation on mainnet or source S-Chain
                    jo_token_manager_schain, // for logs validation on s-chain
                    //
                    nTransactionsCountInBlock,
                    nTransferSteps,
                    nMaxTransactionsCount,
                    nBlockAwaitDepth,
                    nBlockAge,
                    fn_sign_messages,
                    joExtraSignOpts,
                    //
                    tc_dst
                );
                //
                imaState.loopState.s2s.isInProgress = false;
                await pwa.notify_on_loop_end( imaState, "s2s", nIndexS2S );
            }
        } catch ( err ) {
            bOK = false;
            const strError = owaspUtils.extract_error_message( err );
            if( verbose_get() >= RV_VERBOSE().fatal ) {
                log.write( cc.fatal( "S2S STEP ERROR:" ) +
                    cc.error( " From S-Chain " ) + cc.info( chain_id_src ) +
                    cc.error( ", error is: " ) + cc.warning( strError ) +
                    cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                    "\n" );
            }
            //
            imaState.loopState.s2s.isInProgress = false;
            await pwa.notify_on_loop_end( imaState, "s2s", nIndexS2S );
            //
        }
        if( bOK )
            ++ cntOK;
        else
            ++ cntFail;
    }
    joRuntimeOpts.idxChainKnownForS2S = 0; // reset/clear
    joRuntimeOpts.cntChainsKnownForS2S = 0; // reset/clear
    if( "joExtraSignOpts" in joRuntimeOpts )
        delete joRuntimeOpts.joExtraSignOpts; // reset/clear
    if( verbose_get() >= RV_VERBOSE().debug && ( cntOK > 0 || cntFail > 0 ) ) {
        let s = cc.debug( "Stats for S2S steps:" );
        if( cntOK > 0 )
            s += " " + cc.info( cntOK ) + cc.success( " S-Chain(s) processed OKay" ) + cc.debug( ", " );
        if( cntFail > 0 )
            s += " " + cc.info( cntFail ) + cc.error( " S-Chain(s) failed" );
        log.write( s + "\n" );
    }
    return ( cntFail == 0 ) ? true : false;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function compose_gas_usage_report_from_array( strName, jarrReceipts ) {
    if( ! ( strName && typeof strName == "string" && jarrReceipts ) )
        return "";
    let i, sumGasUsed = 0, s = "\n\n" + cc.info( "GAS USAGE REPORT FOR " ) + cc.attention( strName ) + "\n";
    for( i = 0; i < jarrReceipts.length; ++ i ) {
        try {
            sumGasUsed += parseInt( jarrReceipts[i].receipt.gasUsed, 10 );
            s += cc.notice( jarrReceipts[i].description ) + cc.debug( "....." ) + cc.info( jarrReceipts[i].receipt.gasUsed ) + "\n";
        } catch ( err ) { }
    }
    s += cc.attention( "SUM" ) + cc.debug( "....." ) + cc.info( sumGasUsed ) + "\n\n";
    return s;
}

export function print_gas_usage_report_from_array( strName, jarrReceipts ) {
    const s = compose_gas_usage_report_from_array( strName, jarrReceipts );
    if( s && s.length > 0 )
        log.write( s );
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// init helpers
//

export function noop() {
    return null;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export class TransactionCustomizer {
    constructor( gasPriceMultiplier, gasMultiplier ) {
        this.gasPriceMultiplier = gasPriceMultiplier ? ( 0.0 + gasPriceMultiplier ) : null; // null means use current gasPrice or recommendedGasPrice
        this.gasMultiplier = gasMultiplier ? ( 0.0 + gasMultiplier ) : 1.25;
    }
    async computeGasPrice( ethersProvider, maxGasPrice ) {
        const gasPrice = owaspUtils.parseIntOrHex( owaspUtils.toBN( await ethersProvider.getGasPrice() ).toHexString() );
        if( gasPrice == 0 || gasPrice == null || gasPrice == undefined || gasPrice <= 1000000000 )
            return owaspUtils.toBN( "1000000000" ).toHexString();
        else if(
            this.gasPriceMultiplier != null &&
            this.gasPriceMultiplier != undefined &&
            this.gasPriceMultiplier >= 0 &&
            maxGasPrice != null &&
            maxGasPrice != undefined
        ) {
            if( gasPrice * this.gasPriceMultiplier > maxGasPrice )
                return owaspUtils.toBN( maxGasPrice ).toHexString();
            else
                return owaspUtils.toBN( gasPrice ).mul( this.gasPriceMultiplier );
        } else
            return gasPrice;
    }
    async computeGas(
        details,
        ethersProvider,
        strContractName, joContract, strMethodName, arrArguments,
        joAccount, strActionName,
        gasPrice, gasValueRecommended, weiHowMuch,
        opts
    ) {
        let estimatedGas = 0;
        const strContractMethodDescription = cc.notice( strContractName ) + cc.debug( "(" ) + cc.info( joContract.address ) + cc.debug( ")." ) + cc.notice( strMethodName );
        let strArgumentsDescription = "";
        if( arrArguments.length > 0 ) {
            strArgumentsDescription += cc.debug( "( " );
            for( let i = 0; i < arrArguments.length; ++ i ) {
                if( i > 0 )
                    strArgumentsDescription += cc.debug( ", " );
                strArgumentsDescription += cc.j( arrArguments[i] );
            }
            strArgumentsDescription += cc.debug( " )" );
        } else
            strArgumentsDescription += cc.debug( "()" );
        const strContractCallDescription = strContractMethodDescription + strArgumentsDescription;
        const strLogPrefix = strContractMethodDescription + " ";
        try {
            details.write( cc.debug( "Estimate-gas of action " ) + cc.info( strActionName ) + cc.debug( "..." ) + "\n" );
            details.write( cc.debug( "Will estimate-gas " ) + strContractCallDescription + cc.debug( "..." ) + "\n" );
            const strAccountWalletAddress = joAccount.address();
            const callOpts = {
                from: strAccountWalletAddress
            };
            if( gasPrice )
                callOpts.gasPrice = owaspUtils.toBN( gasPrice ).toHexString();
            if( gasValueRecommended )
                callOpts.gasLimit = owaspUtils.toBN( gasValueRecommended ).toHexString();
            if( weiHowMuch )
                callOpts.value = owaspUtils.toBN( weiHowMuch ).toHexString();
            // estimatedGas = await joContract.estimateGas[strMethodName]( ...arrArguments, callOpts );
            // details.write( strLogPrefix + cc.success( "estimate-gas success: " ) + cc.j( estimatedGas ) + "\n" );
        } catch ( err ) {
            const strError = owaspUtils.extract_error_message( err );
            details.write(
                strLogPrefix + cc.error( "estimate-gas error: " ) + cc.warning( strError ) +
                cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) +
                "\n" );
        }
        if( estimatedGas == 0 ) {
            estimatedGas = gasValueRecommended;
            details.write( strLogPrefix + cc.warning( "Will use recommended gas " ) + cc.j( estimatedGas ) + cc.warning( " instead of estimated" ) + "\n" );
        }
        return estimatedGas;
    }
};

let g_tc_main_net = null;
let g_tc_s_chain = null;
let g_tc_t_chain = null;

export function get_tc_main_net() {
    if( g_tc_main_net )
        return g_tc_main_net;
    g_tc_main_net = new TransactionCustomizer( 1.25, 1.25 );
    return g_tc_main_net;
}

export function get_tc_s_chain() {
    if( g_tc_s_chain )
        return g_tc_s_chain;
    g_tc_s_chain = new TransactionCustomizer( null, 1.25 );
    return g_tc_s_chain;
}

export function get_tc_t_chain() {
    if( g_tc_t_chain )
        return g_tc_t_chain;
    g_tc_t_chain = new TransactionCustomizer( null, 1.25 );
    return g_tc_t_chain;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function execShellCommand( cmd ) {
    const exec = child_process.exec;
    return new Promise( ( resolve, reject ) => {
        exec( cmd, ( error, stdout, stderr ) => {
            if( error )
                reject( new Error( stderr ) );
            else
                resolve( stdout ? stdout : stderr );
        } );
    } );
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function balanceETH(
    isMainNet,
    ethersProvider,
    cid,
    joAccount,
    contractERC20
) {
    strLogPrefix = cc.info( "balanceETH() call" ) + " ";
    try {
        if( ! ( ethersProvider && joAccount ) )
            return "<no-data>";
        const strAddress = joAccount.address();
        if( ( !isMainNet ) && contractERC20 ) {
            const balance = await contractERC20.callStatic.balanceOf( strAddress, { from: strAddress } );
            return balance;
        }
        const balance = await ethersProvider.getBalance( strAddress );
        return balance;
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "ERROR:" ) + " " + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
    }
    return "<no-data-or-error>";
}

export async function balanceERC20(
    isMainNet,
    w3,
    cid,
    joAccount,
    strCoinName,
    joABI
) {
    strLogPrefix = cc.info( "balanceERC20() call" ) + " ";
    try {
        if( ! ( w3 && joAccount && strCoinName && joABI && ( strCoinName + "_abi" ) in joABI && ( strCoinName + "_address" ) in joABI ) )
            return "<no-data>";
        const strAddress = joAccount.address();
        const contractERC20 = new owaspUtils.ethersMod.ethers.Contract(
            joABI[strCoinName + "_address"],
            joABI[strCoinName + "_abi"],
            w3
        );
        const balance = await contractERC20.callStatic.balanceOf( strAddress, { from: strAddress } );
        return balance;
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "ERROR:" ) + " " + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
    }
    return "<no-data-or-error>";
}

export async function ownerOfERC721(
    isMainNet,
    w3,
    cid,
    joAccount,
    strCoinName,
    joABI,
    idToken
) {
    strLogPrefix = cc.info( "ownerOfERC721() call" ) + " ";
    try {
        if( ! ( w3 && joAccount && strCoinName && joABI && ( strCoinName + "_abi" ) in joABI && ( strCoinName + "_address" ) in joABI ) )
            return "<no-data>";
        const strAddress = joAccount.address();
        const contractERC721 = owaspUtils.ethersMod.ethers.Contract(
            joABI[strCoinName + "_address"],
            joABI[strCoinName + "_abi"],
            w3
        );
        const owner = await contractERC721.callStatic.ownerOf( idToken, { from: strAddress } );
        return owner;
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "ERROR:" ) + " " + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
    }
    return "<no-data-or-error>";
}

export async function balanceERC1155(
    isMainNet,
    w3,
    cid,
    joAccount,
    strCoinName,
    joABI,
    idToken
) {
    strLogPrefix = cc.info( "balanceERC1155() call" ) + " ";
    try {
        if( ! ( w3 && joAccount && strCoinName && joABI && ( strCoinName + "_abi" ) in joABI && ( strCoinName + "_address" ) in joABI ) )
            return "<no-data>";
        const strAddress = joAccount.address();
        const contractERC1155 = new owaspUtils.ethersMod.ethers.Contract(
            joABI[strCoinName + "_address"],
            joABI[strCoinName + "_abi"],
            w3
        );
        const balance = await contractERC1155.callStatic.balanceOf( strAddress, idToken, { from: strAddress } );
        return balance;
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "ERROR:" ) + " " + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
    }
    return "<no-data-or-error>";
}

export async function mintERC20(
    w3,
    cid,
    chainName,
    joAccount,
    strAddressMintTo,
    nAmount,
    strTokenContractAddress,
    joTokenContractABI,
    tc
) {
    let strActionName = "mintERC20() init";
    const strLogPrefix = cc.info( "mintERC20() call" ) + " ";
    const details = log.createMemoryStream();
    try {
        details.write( strLogPrefix + cc.debug( "Mint " ) + cc.info( "ERC20" ) + cc.debug( " token amount " ) + cc.notice( nAmount ) + "\n" );
        if( ! ( w3 &&
            joAccount &&
            strAddressMintTo && typeof strAddressMintTo == "string" && strAddressMintTo.length > 0 &&
            strTokenContractAddress && typeof strTokenContractAddress == "string" && strTokenContractAddress.length > 0 &&
            joTokenContractABI
        ) )
            throw new Error( "Missing valid arguments" );
        strActionName = "mintERC20() instantiate token contract";
        const contract = new owaspUtils.ethersMod.ethers.Contract(
            strTokenContractAddress,
            joTokenContractABI,
            w3
        );
        const arrArguments_mint = [
            strAddressMintTo,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( nAmount ).toHexString() )
        ];
        const weiHowMuch_mint = undefined;
        const gasPrice = await tc.computeGasPrice( ethersProvider, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_mint =
            await tc.computeGas(
                details,
                ethersProvider,
                "ERC20", contract, "mint", arrArguments_mint,
                joAccount, strActionName,
                gasPrice, 10000000, weiHowMuch_mint,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_mint ) + "\n" );
        strActionName = "Mint ERC20";
        const isIgnore_mint = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider,
                "ERC20", contract, "mint", arrArguments_mint,
                joAccount, strActionName, isIgnore_mint,
                gasPrice, estimatedGas_mint, weiHowMuch_mint,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        let opts = {
            isCheckTransactionToSchain: ( chain_id_dst !== "Mainnet" ) ? true : false
        };
        const joReceipt =
            await payed_call(
                details,
                ethersProvider,
                "ERC20", contract, "mint", arrArguments_mint,
                joAccount, strActionName,
                gasPrice, estimatedGas_mint, weiHowMuch_mint,
                opts
            );
        print_gas_usage_report_from_array( "MINT ERC20 ", [ {
            "description": "mintERC20()/mint",
            "receipt": joReceipt
        } ] );
        if( expose_details_get() )
            details.exposeDetailsTo( log, "mintERC20", true );
        details.close();
        return joReceipt; // can be used as "true" boolean value
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in mintERC20() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in mintERC20() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.exposeDetailsTo( log, "mintERC20()", false );
        details.close();
        return false;
    }
}

export async function mintERC721(
    w3,
    cid,
    chainName,
    joAccount,
    strAddressMintTo,
    idToken,
    strTokenContractAddress,
    joTokenContractABI,
    tc
) {
    let strActionName = "mintERC721() init";
    const strLogPrefix = cc.info( "mintERC721() call" ) + " ";
    const details = log.createMemoryStream();
    try {
        details.write( strLogPrefix + cc.debug( "Mint " ) + cc.info( "ERC721" ) + cc.debug( " token ID " ) + cc.notice( idToken ) + "\n" );
        if( ! ( w3 &&
            joAccount &&
            strAddressMintTo && typeof strAddressMintTo == "string" && strAddressMintTo.length > 0 &&
            strTokenContractAddress && typeof strTokenContractAddress == "string" && strTokenContractAddress.length > 0 &&
            joTokenContractABI
        ) )
            throw new Error( "Missing valid arguments" );
        strActionName = "mintERC721() instantiate token contract";
        const contract =
            new owaspUtils.ethersMod.ethers.Contract(
                strTokenContractAddress,
                joTokenContractABI,
                w3
            );
        const arrArguments_mint = [
            strAddressMintTo,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( idToken ).toHexString() )
        ];
        const weiHowMuch_mint = undefined;
        const gasPrice = await tc.computeGasPrice( w3, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_mint =
            await tc.computeGas(
                details,
                w3,
                "ERC721", contract, "mint", arrArguments_mint,
                joAccount, strActionName,
                gasPrice, 10000000, weiHowMuch_mint,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_mint ) + "\n" );
        strActionName = "Mint ERC721";
        const isIgnore_mint = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                w3,
                "ERC721", contract, "mint", arrArguments_mint,
                joAccount, strActionName, isIgnore_mint,
                gasPrice, estimatedGas_mint, weiHowMuch_mint,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        let opts = {
            isCheckTransactionToSchain: ( chain_id_dst !== "Mainnet" ) ? true : false
        };
        const joReceipt =
            await payed_call(
                details,
                w3,
                "ERC721", contract, "mint", arrArguments_mint,
                joAccount, strActionName,
                gasPrice, estimatedGas_mint, weiHowMuch_mint,
                opts
            );
        print_gas_usage_report_from_array( "MINT ERC721 ", [ {
            "description": "mintERC721()/mint",
            "receipt": joReceipt
        } ] );
        if( expose_details_get() )
            details.exposeDetailsTo( log, "mintERC721", true );
        details.close();
        return joReceipt; // can be used as "true" boolean value
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in mintERC721() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in mintERC721() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.exposeDetailsTo( log, "mintERC721()", false );
        details.close();
        return false;
    }
}

export async function mintERC1155(
    w3,
    cid,
    chainName,
    joAccount,
    strAddressMintTo,
    idToken,
    nAmount,
    strTokenContractAddress,
    joTokenContractABI,
    tc
) {
    let strActionName = "mintERC1155() init";
    const strLogPrefix = cc.info( "mintERC1155() call" ) + " ";
    const details = log.createMemoryStream();
    try {
        details.write( strLogPrefix + cc.debug( "Mint " ) + cc.info( "ERC1155" ) + cc.debug( " token ID " ) + cc.notice( idToken ) + cc.debug( " token amount " ) + cc.notice( nAmount ) + "\n" );
        if( ! ( w3 &&
            joAccount &&
            strAddressMintTo && typeof strAddressMintTo == "string" && strAddressMintTo.length > 0 &&
            strTokenContractAddress && typeof strTokenContractAddress == "string" && strTokenContractAddress.length > 0 &&
            joTokenContractABI
        ) )
            throw new Error( "Missing valid arguments" );
        strActionName = "mintERC1155() instantiate token contract";
        const contract =
            new owaspUtils.ethersMod.ethers.Contract(
                strTokenContractAddress,
                joTokenContractABI,
                w3
            );
        const arrArguments_mint = [
            strAddressMintTo,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( idToken ).toHexString() ),
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( nAmount ).toHexString() ),
            [] // data
        ];
        const weiHowMuch_mint = undefined;
        const gasPrice = await tc.computeGasPrice( w3, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_mint =
            await tc.computeGas(
                details,
                w3,
                "ERC1155", contract, "mint", arrArguments_mint,
                joAccount, strActionName,
                gasPrice, 10000000, weiHowMuch_mint,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_mint ) + "\n" );
        strActionName = "Mint ERC1155";
        const isIgnore_mint = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                w3,
                "ERC1155", contract, "mint", arrArguments_mint,
                joAccount, strActionName, isIgnore_mint,
                gasPrice, estimatedGas_mint, weiHowMuch_mint,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        let opts = {
            isCheckTransactionToSchain: ( chain_id_dst !== "Mainnet" ) ? true : false
        };
        const joReceipt =
            await payed_call(
                details,
                w3,
                "ERC1155", contract, "mint", arrArguments_mint,
                joAccount, strActionName,
                gasPrice, estimatedGas_mint, weiHowMuch_mint,
                opts
            );
        print_gas_usage_report_from_array( "MINT ERC1155 ", [ {
            "description": "mintERC1155()/mint",
            "receipt": joReceipt
        } ] );
        if( expose_details_get() )
            details.exposeDetailsTo( log, "mintERC1155", true );
        details.close();
        return joReceipt; // can be used as "true" boolean value
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in mintERC1155() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in mintERC1155() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.exposeDetailsTo( log, "mintERC1155()", false );
        details.close();
        return false;
    }
}

export async function burnERC20(
    w3,
    cid,
    chainName,
    joAccount,
    strAddressBurnFrom,
    nAmount,
    strTokenContractAddress,
    joTokenContractABI,
    tc
) {
    let strActionName = "burnERC20() init";
    const strLogPrefix = cc.info( "burnERC20() call" ) + " ";
    const details = log.createMemoryStream();
    try {
        details.write( strLogPrefix + cc.debug( "Burn " ) + cc.info( "ERC20" ) + cc.debug( " token amount " ) + cc.notice( nAmount ) + "\n" );
        if( ! ( w3 &&
            joAccount &&
            strAddressBurnFrom && typeof strAddressBurnFrom == "string" && strAddressBurnFrom.length > 0 &&
            strTokenContractAddress && typeof strTokenContractAddress == "string" && strTokenContractAddress.length > 0 &&
            joTokenContractABI
        ) )
            throw new Error( "Missing valid arguments" );
        strActionName = "burnERC20() instantiate token contract";
        const contract =
            new owaspUtils.ethersMod.ethers.Contract(
                strTokenContractAddress,
                joTokenContractABI,
                w3
            );
        const arrArguments_burn = [
            strAddressBurnFrom,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( nAmount ).toHexString() )
        ];
        const weiHowMuch_burn = undefined;
        const gasPrice = await tc.computeGasPrice( ethersProvider, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_burn =
            await tc.computeGas(
                details,
                ethersProvider,
                "ERC20", contract, "burnFrom", arrArguments_burn,
                joAccount, strActionName,
                gasPrice, 10000000, weiHowMuch_burn,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_burn ) + "\n" );
        strActionName = "Burn ERC20";
        const isIgnore_burn = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider,
                "ERC20", contract, "burnFrom", arrArguments_burn,
                joAccount, strActionName, isIgnore_burn,
                gasPrice, estimatedGas_burn, weiHowMuch_burn,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        let opts = {
            isCheckTransactionToSchain: ( chain_id_dst !== "Mainnet" ) ? true : false
        };
        const joReceipt =
            await payed_call(
                details,
                ethersProvider,
                "ERC20", contract, "burnFrom", arrArguments_burn,
                joAccount, strActionName,
                gasPrice, estimatedGas_burn, weiHowMuch_burn,
                opts
            );
        print_gas_usage_report_from_array( "BURN ERC20 ", [ {
            "description": "burnERC20()/burn",
            "receipt": joReceipt
        } ] );
        if( expose_details_get() )
            details.exposeDetailsTo( log, "burnERC20", true );
        details.close();
        return joReceipt; // can be used as "true" boolean value
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in burnERC20() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in burnERC20() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.exposeDetailsTo( log, "burnERC20()", false );
        details.close();
        return false;
    }
}

export async function burnERC721(
    w3,
    cid,
    chainName,
    joAccount,
    // strAddressBurnFrom,
    idToken,
    strTokenContractAddress,
    joTokenContractABI,
    tc
) {
    let strActionName = "burnERC721() init";
    const strLogPrefix = cc.info( "burnERC721() call" ) + " ";
    const details = log.createMemoryStream();
    try {
        details.write( strLogPrefix + cc.debug( "Burn " ) + cc.info( "ERC721" ) + cc.debug( " token ID " ) + cc.notice( idToken ) + "\n" );
        if( ! ( w3 &&
            joAccount &&
            //strAddressBurnFrom && typeof strAddressBurnFrom == "string" && strAddressBurnFrom.length > 0 &&
            strTokenContractAddress && typeof strTokenContractAddress == "string" && strTokenContractAddress.length > 0 &&
            joTokenContractABI
        ) )
            throw new Error( "Missing valid arguments" );
        strActionName = "burnERC721() instantiate token contract";
        const contract =
            new owaspUtils.ethersMod.ethers.Contract(
                strTokenContractAddress,
                joTokenContractABI,
                w3
            );
        const arrArguments_burn = [
            //strAddressBurnFrom,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( idToken ).toHexString() )
        ];
        const weiHowMuch_burn = undefined;
        const gasPrice = await tc.computeGasPrice( ethersProvider, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_burn =
            await tc.computeGas(
                details,
                ethersProvider,
                "ERC721", contract, "burn", arrArguments_burn,
                joAccount, strActionName,
                gasPrice, 10000000, weiHowMuch_burn,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_burn ) + "\n" );
        strActionName = "Burn ERC721";
        const isIgnore_burn = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider,
                "ERC721", contract, "burn", arrArguments_burn,
                joAccount, strActionName, isIgnore_burn,
                gasPrice, estimatedGas_burn, weiHowMuch_burn,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        let opts = {
            isCheckTransactionToSchain: ( chain_id_dst !== "Mainnet" ) ? true : false
        };
        const joReceipt =
            await payed_call(
                details,
                ethersProvider,
                "ERC721", contract, "burn", arrArguments_burn,
                joAccount, strActionName,
                gasPrice, estimatedGas_burn, weiHowMuch_burn,
                opts
            );
        print_gas_usage_report_from_array( "BURN ERC721 ", [ {
            "description": "burnERC721()/burn",
            "receipt": joReceipt
        } ] );
        if( expose_details_get() )
            details.exposeDetailsTo( log, "burnERC721", true );
        details.close();
        return joReceipt; // can be used as "true" boolean value
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in burnERC721() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in burnERC721() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.exposeDetailsTo( log, "burnERC721()", false );
        details.close();
        return false;
    }
}

export async function burnERC1155(
    w3,
    cid,
    chainName,
    joAccount,
    strAddressBurnFrom,
    idToken,
    nAmount,
    strTokenContractAddress,
    joTokenContractABI,
    tc
) {
    let strActionName = "burnERC1155() init";
    const strLogPrefix = cc.info( "burnERC1155() call" ) + " ";
    const details = log.createMemoryStream();
    try {
        details.write( strLogPrefix + cc.debug( "Burn " ) + cc.info( "ERC1155" ) + cc.debug( " token ID " ) + cc.notice( idToken ) + cc.debug( " token amount " ) + cc.notice( nAmount ) + "\n" );
        if( ! ( w3 &&
            joAccount &&
            strAddressBurnFrom && typeof strAddressBurnFrom == "string" && strAddressBurnFrom.length > 0 &&
            strTokenContractAddress && typeof strTokenContractAddress == "string" && strTokenContractAddress.length > 0 &&
            joTokenContractABI
        ) )
            throw new Error( "Missing valid arguments" );
        strActionName = "burnERC1155() instantiate token contract";
        const contract =
            new owaspUtils.ethersMod.ethers.Contract(
                strTokenContractAddress,
                joTokenContractABI,
                w3
            );
        const arrArguments_burn = [
            strAddressBurnFrom,
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( idToken ).toHexString() ),
            owaspUtils.ensure_starts_with_0x( owaspUtils.toBN( nAmount ).toHexString() )
        ];
        const weiHowMuch_burn = undefined;
        const gasPrice = await tc.computeGasPrice( ethersProvider, 200000000000 );
        details.write( strLogPrefix + cc.debug( "Using computed " ) + cc.info( "gasPrice" ) + cc.debug( "=" ) + cc.notice( gasPrice ) + "\n" );
        const estimatedGas_burn =
            await tc.computeGas(
                details,
                ethersProvider,
                "ERC1155", contract, "burn", arrArguments_burn,
                joAccount, strActionName,
                gasPrice, 10000000, weiHowMuch_burn,
                null
            );
        details.write( strLogPrefix + cc.debug( "Using estimated " ) + cc.info( "gas" ) + cc.debug( "=" ) + cc.notice( estimatedGas_burn ) + "\n" );
        strActionName = "Burn ERC1155";
        const isIgnore_burn = false;
        const strErrorOfDryRun =
            await dry_run_call(
                details,
                ethersProvider,
                "ERC1155", contract, "burn", arrArguments_burn,
                joAccount, strActionName, isIgnore_burn,
                gasPrice, estimatedGas_burn, weiHowMuch_burn,
                null
            );
        if( strErrorOfDryRun )
            throw new Error( strErrorOfDryRun );

        let opts = {
            
            ToSchain: ( chain_id_dst !== "Mainnet" ) ? true : false
        };
        const joReceipt =
            await payed_call(
                details,
                ethersProvider,
                "ERC1155", contract, "burn", arrArguments_burn,
                joAccount, strActionName,
                gasPrice, estimatedGas_burn, weiHowMuch_burn,
                opts
            );
        print_gas_usage_report_from_array( "BURN ERC1155 ", [ {
            "description": "burnERC1155()/burn",
            "receipt": joReceipt
        } ] );
        if( expose_details_get() )
            details.exposeDetailsTo( log, "burnERC1155", true );
        details.close();
        return joReceipt; // can be used as "true" boolean value
    } catch ( err ) {
        const strError = owaspUtils.extract_error_message( err );
        if( verbose_get() >= RV_VERBOSE().fatal )
            log.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in burnERC1155() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.write( strLogPrefix + cc.fatal( "CRITICAL ERROR:" ) + cc.error( " Error in burnERC1155() during " + strActionName + ": " ) + cc.error( strError ) + cc.error( ", stack is: " ) + "\n" + cc.stack( err.stack ) + "\n" );
        details.exposeDetailsTo( log, "burnERC1155()", false );
        details.close();
        return false;
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
