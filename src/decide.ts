import { existsSync, writeFileSync } from "fs";
import parseTorrent, { Metafile } from "parse-torrent";
import path from "path";
import { appDir } from "./configuration.js";
import { Decision, TORRENT_CACHE_FOLDER } from "./constants.js";
import db, { DecisionEntry } from "./db.js";
import { ProwlarrResult } from "./prowlarr.js";
import { Label, logger } from "./logger.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import { Searchee } from "./searchee.js";
import { parseTorrentFromFilename, parseTorrentFromURL } from "./torrent.js";

export interface ResultAssessment {
	decision: Decision;
	info?: Metafile;
}

const createReasonLogger =
	(Title: string, tracker: number, name: string) =>
	(decision: Decision, cached): void => {
		function logReason(reason): void {
			logger.verbose({
				label: Label.DECIDE,
				message: `${name} - no match for ${tracker} torrent ${Title} - ${reason}`,
			});
		}
		let reason;
		switch (decision) {
			case Decision.MATCH:
				return;
			case Decision.SIZE_MISMATCH:
				reason = "its size does not match";
				break;
			case Decision.NO_DOWNLOAD_LINK:
				reason = "it doesn't have a download link";
				break;
			case Decision.DOWNLOAD_FAILED:
				reason = "the torrent file failed to download";
				break;
			case Decision.INFO_HASH_ALREADY_EXISTS:
				reason = "the info hash matches a torrent you already have";
				break;
			case Decision.FILE_TREE_MISMATCH:
				reason = "it has a different file tree";
				break;
			default:
				reason = decision;
				break;
		}
		if (cached) logReason(`${reason} (cached)`);
		else logReason(reason);
	};

export function compareFileTrees(
	candidate: Metafile,
	searchee: Searchee
): boolean {
	const cmp = (elOfA, elOfB) => {
		const lengthsAreEqual = elOfB.length === elOfA.length;
		const pathsAreEqual = elOfB.path === elOfA.path;

		return lengthsAreEqual && pathsAreEqual;
	};

	return candidate.files.every((elOfA) =>
		searchee.files.some((elOfB) => cmp(elOfA, elOfB))
	);
}

function sizeDoesMatch(resultSize, searchee) {
	const { fuzzySizeThreshold } = getRuntimeConfig();

	const { length } = searchee;
	const lowerBound = length - fuzzySizeThreshold * length;
	const upperBound = length + fuzzySizeThreshold * length;
	return resultSize >= lowerBound && resultSize <= upperBound;
}

async function assessResultHelper(
	{ Link, Size }: ProwlarrResult,
	searchee: Searchee,
	hashesToExclude: string[]
): Promise<ResultAssessment> {
	if (!sizeDoesMatch(Size, searchee)) {
		return { decision: Decision.SIZE_MISMATCH };
	}

	if (!Link) return { decision: Decision.NO_DOWNLOAD_LINK };

	const info = await parseTorrentFromURL(Link);

	if (!info) return { decision: Decision.DOWNLOAD_FAILED };

	if (hashesToExclude.includes(info.infoHash)) {
		return { decision: Decision.INFO_HASH_ALREADY_EXISTS };
	}

	if (!compareFileTrees(info, searchee)) {
		return { decision: Decision.FILE_TREE_MISMATCH };
	}

	return { decision: Decision.MATCH, info };
}

function existsInTorrentCache(infoHash: string): boolean {
	return existsSync(
		path.join(appDir(), TORRENT_CACHE_FOLDER, `${infoHash}.cached.torrent`)
	);
}

async function getCachedTorrentFile(infoHash: string): Promise<Metafile> {
	return parseTorrentFromFilename(
		path.join(appDir(), TORRENT_CACHE_FOLDER, `${infoHash}.cached.torrent`)
	);
}

function cacheTorrentFile(meta: Metafile): void {
	writeFileSync(
		path.join(
			appDir(),
			TORRENT_CACHE_FOLDER,
			`${meta.infoHash}.cached.torrent`
		),
		parseTorrent.toTorrentFile(meta)
	);
}

async function assessAndSaveResults(
	result: ProwlarrResult,
	searchee: Searchee,
	Guid: string,
	infoHashesToExclude: string[]
) {
	const assessment = await assessResultHelper(
		result,
		searchee,
		infoHashesToExclude
	);

	db.data.decisions[searchee.name][Guid] = {
		decision: assessment.decision,
		lastSeen: Date.now(),
		firstSeen: Date.now(),
	};

	if (assessment.decision === Decision.MATCH) {
		db.data.decisions[searchee.name][Guid].infoHash =
			assessment.info.infoHash;
		cacheTorrentFile(assessment.info);
	}
	return assessment;
}

async function assessResultCaching(
	result: ProwlarrResult,
	searchee: Searchee,
	infoHashesToExclude: string[]
): Promise<ResultAssessment> {
	const { Guid, Title, IndexerId: tracker } = result;
	const logReason = createReasonLogger(Title, tracker, searchee.name);

	db.data.decisions[searchee.name] ??= {};
	const cacheEntry: DecisionEntry = db.data.decisions[searchee.name][Guid];

	let assessment: ResultAssessment;

	if (
		!cacheEntry?.decision ||
		cacheEntry.decision === Decision.DOWNLOAD_FAILED
	) {
		assessment = await assessAndSaveResults(
			result,
			searchee,
			Guid,
			infoHashesToExclude
		);
		logReason(assessment.decision, false);
	} else if (
		cacheEntry.decision === Decision.MATCH &&
		infoHashesToExclude.includes(cacheEntry.infoHash)
	) {
		// has been added since the last run
		assessment = { decision: Decision.INFO_HASH_ALREADY_EXISTS };
		db.data.decisions[searchee.name][Guid].decision =
			Decision.INFO_HASH_ALREADY_EXISTS;
	} else if (
		cacheEntry.decision === Decision.MATCH &&
		existsInTorrentCache(cacheEntry.infoHash)
	) {
		// cached match
		assessment = {
			decision: cacheEntry.decision,
			info: await getCachedTorrentFile(cacheEntry.infoHash),
		};
	} else if (cacheEntry.decision === Decision.MATCH) {
		assessment = await assessAndSaveResults(
			result,
			searchee,
			Guid,
			infoHashesToExclude
		);
		logReason(assessment.decision, false);
	} else {
		// cached rejection
		assessment = { decision: cacheEntry.decision };
		logReason(cacheEntry.decision, true);
	}
	db.data.decisions[searchee.name][Guid].lastSeen = Date.now();
	db.write();
	return assessment;
}

export { assessResultCaching as assessResult };
