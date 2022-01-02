import querystring from "querystring";
import get from "simple-get";
import { EP_REGEX, MOVIE_REGEX, SEASON_REGEX } from "./constants.js";
import { CrossSeedError } from "./errors.js";
import { Label, logger } from "./logger.js";
import {
	EmptyNonceOptions,
	getRuntimeConfig,
	NonceOptions,
} from "./runtimeConfig.js";

export interface ProwlarrResult {
	Author: unknown;
	BlackholeLink: string;
	BookTitle: unknown;
	Category: number[];
	CategoryDesc: string;
	Description: unknown;
	Details: string;
	DownloadVolumeFactor: number;
	Files: number;
	FirstSeen: string;
	Gain: number;
	Grabs: number;
	Guid: string;
	Imdb: unknown;
	InfoHash: unknown;
	Link: string;
	MagnetUri: unknown;
	MinimumRatio: number;
	MinimumSeedTime: number;
	Peers: number;
	Poster: unknown;
	PublishDate: string;
	RageID: unknown;
	Seeders: number;
	Size: number;
	TMDb: unknown;
	TVDBId: unknown;
	Title: string;
	Indexer: string;
	IndexerId: number;
	UploadVolumeFactor: number;
}

function reformatTitleForSearching(name: string): string {
	const seasonMatch = name.match(SEASON_REGEX);
	const movieMatch = name.match(MOVIE_REGEX);
	const episodeMatch = name.match(EP_REGEX);
	const fullMatch = episodeMatch
		? episodeMatch[0]
		: seasonMatch
		? seasonMatch[0]
		: movieMatch
		? movieMatch[0]
		: name;
	return fullMatch
		.replace(/[.()[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function fullProwlarrUrl(prowlarrServerUrl: string, params) {
	const prowlarrPath = `/api/v1/search`;
	return `${prowlarrServerUrl}${prowlarrPath}?${querystring.encode(params)}`;
}

export async function validateProwlarrApi(): Promise<void> {
	const { prowlarrServerUrl, prowlarrApiKey: apikey } = getRuntimeConfig();

	if (/\/$/.test(prowlarrServerUrl)) {
		logger.warn("Warning: Prowlarr server url should not end with '/'");
	}

	// search for gibberish so the results will be empty
	const gibberish = "bscdjpstabgdspjdasmomdsenqciadsnocdpsikncaodsnimcdqsanc";
	try {
		await makeProwlarrRequest(gibberish);
	} catch (e) {
		const dummyUrl = fullProwlarrUrl(prowlarrServerUrl, { apikey });
		throw new CrossSeedError(`Could not reach Prowlarr at ${dummyUrl}`);
	}
}

export function makeProwlarrRequest(
	name: string,
	nonceOptions: NonceOptions = EmptyNonceOptions
): Promise<ProwlarrResult[]> {
	const {
		prowlarrApiKey,
		trackers: runtimeConfigTrackers,
		prowlarrServerUrl,
	} = getRuntimeConfig();
	const { trackers = runtimeConfigTrackers } = nonceOptions;
	const params = {
		apikey: prowlarrApiKey,
		query: reformatTitleForSearching(name),
		indexerIds: trackers,
	};

	const opts = {
		method: "GET",
		url: fullProwlarrUrl(prowlarrServerUrl, params),
		json: true,
	};

	logger.verbose({
		label: Label.PROWLARR,
		message: `making search with query "${params.query}"`,
	});

	return new Promise((resolve, reject) => {
		get.concat(opts, (err, res, data) => {
			if (err) reject(err);
			else resolve(data);
		});
	});
}
