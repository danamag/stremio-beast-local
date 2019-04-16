const pUrl = require('url')

const { config, persist } = require('internal')

const needle = require('needle')
const cheerio = require('cheerio')

const defaults = {
	name: 'Twisted IPTV',
	prefix: 'twistedtv_',
	origin: 'http://twistedoffline.com',
	endpoint: 'http://twistedoffline.com/player/',
	icon: 'https://s3-us-west-2.amazonaws.com/usedphotosna/81320118_614.jpg',
	categories: [{"name":"* SUBJECT TO CHANGE *","id":"134"},{"name":"PPV | SPECIAL EVENTS","id":"24"},{"name":"24/7","id":"46"},{"name":"24/7 KIDS","id":"201"},{"name":"24/7 IN HOUSE","id":"227"},{"name":"USA CHANNELS","id":"37"},{"name":"USA 2 CHANNELS","id":"216"},{"name":"USA SD CHANNELS","id":"200"},{"name":"LOCAL CHANNELS","id":"214"},{"name":"CANADIAN CHANNELS","id":"239"},{"name":"INTERNATIONAL CHANNELS","id":"182"},{"name":"UK CHANNELS","id":"44"},{"name":"UK SD CHANNELS","id":"225"},{"name":"MARCH MADNESS","id":"238"},{"name":"MLB CHANNELS","id":"233"},{"name":"NASCAR","id":"229"},{"name":"NBA LEAGUE PASS","id":"88"},{"name":"NFL SUNDAY TICKET","id":"197"},{"name":"NHL HOCKEY","id":"56"},{"name":"ESPN SPORTS","id":"195"},{"name":"MUSIC CHOICE VIDEO","id":"140"},{"name":"PLUTO TV RADIO","id":"194"},{"name":"RADIO CHANNELS","id":"101"},{"name":"RELIGION CHANNELS","id":"219"},{"name":"WORLD WEBCAMS","id":"209"},{"name":"xxx CHANNELS xxx","id":"18"},{"name":"TEST CHANNELS","id":"85"}]
}

let genres = []
let categories = []
let catalogs = []
const channels = {}
let token, cookies, origin, endpoint, ajaxEndpoint

const headers = {
	'Accept': 'text/plain, */*; q=0.01',
	'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
	'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.86 Safari/537.36',
	'X-Requested-With': 'XMLHttpRequest'
}

function setEndpoint(str) {
	if (str) {
		let host = str
		if (host.endsWith('/index.php'))
			host = host.replace('/index.php', '/')
		if (!host.endsWith('/'))
			host += '/'
		endpoint = host
		origin = endpoint.replace(pUrl.parse(endpoint).path, '')
		ajaxEndpoint = endpoint + 'includes/ajax-control.php'
		headers['Origin'] = origin
		headers['Referer'] = endpoint + 'index.php'
	}
	return true
}

setEndpoint(config.host || defaults.endpoint)

function setCatalogs(cats) {
	categories = cats
	if (config.style == 'Catalogs') {
		catalogs = []
		cats.forEach(cat => {
			catalogs.push({
				id: defaults.prefix + 'cat_' + cat.id,
				name: cat.name,
				type: 'tv',
				extra: [ { name: 'search' } ]
			})
		})
	} else if (config.style == 'Filters') {
		genres = defaults.categories.map(el => { return el.name })
		catalogs = [
			{
				id: defaults.prefix + '_cat',
				name: defaults.name,
				type: 'tv',
				genres,
				extra: [{ name: 'genre' }]
			}
		]
	} else if (config.style == 'Channels') {
		catalogs = [
			{
				id: defaults.prefix + '_cat',
				name: defaults.name,
				type: 'tv',
				extra: [{ name: 'search' }]
			}
		]
	}
	return true
}

setCatalogs(defaults.categories)

function catToMeta(cat) {
	return {
		id: defaults.prefix + 'cat_' + cat.id,
		name: cat.name,
		logo: defaults.icon,
		type: 'channel',
		posterShape: 'square'
	}
}

function catToVideo(cat) {
	return {
		id: cat.id,
		title: cat.name,
		thumbnail: cat.poster
	}
}

let loggedIn = false

// not using logout anywhere yet
function logout(cb) {
	const payload = 'action=logoutProcess'
	needle.post(ajaxEndpoint, payload, { headers, cookies }, (err, resp, body) => {
		if (!err) {
			loggedIn = false
			cookies = undefined
			cb(true)
		} else
			cb()
	})
}

function isLogedIn(cb) {
	if (loggedIn)
		return cb(true)
	const payload = 'action=webtvlogin&uname='+config.username+'&upass='+config.password+'&rememberMe=off'
	needle.post(ajaxEndpoint, payload, { headers, cookies }, (err, resp, body) => {
		if (body) {
			cookies = resp.cookies
			if (typeof body == 'string') {
				try {
					body = JSON.parse(body)
				} catch(e) {
					console.log(defaults.name + ' - Error')
					console.error(e.message || 'Unable to parse JSON response from ' + defaults.name + ' server')
				}
			}
			if (body.result == 'error') {
				console.log(defaults.name + ' - Error')
				console.error(body.message || 'Failed to log in')
				cb()
			} else if (body.result == 'success') {
				const msg = (body.message || {})
				if (msg.max_connections && msg.active_cons >= msg.max_connections) {
					console.log(defaults.name + ' - Error')
					console.error('Too many connections to ' + defaults.name + ' server, stop a connection and restart add-on')
					cb(false)
				} else {
					// login success
					loggedIn = true
					console.log(defaults.name + ' - Logged In')
					persist.setItem('loginData', msg)
					getCategories(success => {
						if (success)
							console.log(defaults.name + ' - Updated catalogs successfully')
						else
							console.log(defaults.name + ' - Could not update catalogs from server')

						cb(true)
					})
				}
			} else {
				console.log(defaults.name + ' - Error')
				console.error('Unknown response from server')
				cb()
			}
		} else {
			console.log(defaults.name + ' - Error')
			console.error('Invalid response from server')
			cb()
		}
	})
}

function request(url, payload, cb) {
	isLogedIn(() => { needle.post(url, payload, { headers, cookies }, cb) })
}

function findChannel(query, chans) {
	const results = []
	chans.forEach(chan => {
		if (chan.name.toLowerCase().includes(query.toLowerCase()))
			results.push(chan)
	})
	return results
}

function findMeta(id) {
	const idParts = id.split('_')
	const catId = idParts[1]
	let meta
	channels[catId].some(chan => {
		if (chan.id == id) {
			meta = chan
			return true
		}
	})
	return meta
}

function getCatalog(args, cb, force) {
	let id
	if (config.style == 'Catalogs') {
		id = args.id.replace(defaults.prefix + 'cat_', '')
	} else if (config.style == 'Filters') {
		const genre = (args.extra || {}).genre
		if (genre)
			categories.some(el => {
				if (el.name == genre) {
					id = el.id
					return true
				}
			})
		if (!id) {
			console.log(defaults.name + ' - Could not get id for request')
			cb(false)
			return
		}
	} else if (config.style == 'Channels') {
		if (force) {
			id = args.id.replace(defaults.prefix + 'cat_', '')
		} else {
			cb(categories.map(catToMeta))
			return
		}
	}
	if (channels[id] && channels[id].length)
		cb(channels[id])
	else {
		const payload = 'action=getStreamsFromID&categoryID=' + id + '&hostURL=' + encodeURIComponent('http://' + persist.getItem('loginData').url + ':' + persist.getItem('loginData').port + '/')
		request(ajaxEndpoint, payload, (err, resp, body) => {
			if (!err && body) {
				const $ = cheerio.load(body)
				channels[id] = []

				$('li.streamList').each((ij, el) => {
					const elem = $(el)
					let poster = $(el).find('img').attr('src')
					if (poster.startsWith('images/'))
						poster = endpoint + poster
					channels[id].push({
						id: defaults.prefix + id + '_' + elem.find('.streamId').attr('value'),
						type: 'tv',
						name: elem.find('label').text().trim(),
						poster, background: poster, logo: poster,
						posterShape: 'square'
					})
				})

				cb(channels[id])
			} else
				cb(false)
		})
	}
}

function addZero(deg) {
	return ('0' + deg).slice(-2)
}

function getCategories(cb) {
	const date = new Date()
	const payload = 'dateFullData=' + (date.getDay() +1) + '-' + (date.getMonth() +1) + '-' + date.getFullYear() + '+' + encodeURIComponent(addZero(date.getHours()) + ":" + addZero(date.getMinutes()) + ":" + addZero(date.getSeconds()))
	needle.post(endpoint + 'live.php', payload, { headers, cookies }, (err, resp, body) => {
		if (!err && body) {
			const $ = cheerio.load(body)
			const results = []
			$('.cbp-spmenu li a').each((ij, el) => {
				const elm = $(el)
				results.push({ name: elm.text().trim(), id: elm.attr('data-categoryid') })
			})
			if (results.length) {
				setCatalogs(results)
				cb(true)
			} else
				cb(false)
		} else
			cb(false)
	})
}

function retrieveManifest() {
	function manifest() {
		return {
			id: 'org.' + defaults.name.toLowerCase().replace(/[^a-z]+/g,''),
			version: '1.0.0',
			name: defaults.name,
			description: 'IPTV Service - Requires Subscription',
			resources: ['stream', 'meta', 'catalog'],
			types: ['tv', 'channel'],
			idPrefixes: [defaults.prefix],
			icon: defaults.icon,
			catalogs
		}
	}

	return new Promise((resolve, reject) => {
		isLogedIn(() => { resolve(manifest()) })
	})
}

async function retrieveRouter() {
	const manifest = await retrieveManifest()

	const { addonBuilder, getInterface, getRouter } = require('stremio-addon-sdk')

	const builder = new addonBuilder(manifest)

	builder.defineCatalogHandler(args => {
		return new Promise((resolve, reject) => {
			const extra = args.extra || {}
			if (config.style == 'Filters' && !extra.genre) {
				return resolve({ metas: [] })
			}
			getCatalog(args, catalog => {
				if (catalog) {
					let results = catalog
					if (extra.search)
						results = findChannel(extra.search, catalog)
					if (results.length)
						resolve({ metas: results })
					else
						reject(defaults.name + ' - No results for catalog request')
				} else
					reject(defaults.name + ' - Invalid catalog response')
			})
		})
	})

	builder.defineMetaHandler(args => {
		return new Promise((resolve, reject) => {
			if (config.style == 'Channels') {
				let meta
				categories.some(cat => {
					if (cat.id == args.id.replace(defaults.prefix + 'cat_', '')) {
						meta = catToMeta(cat)
						return true
					}
				})
				if (!meta) {
					reject(defaults.name + ' - Could not get meta')
					return
				}
				getCatalog(args, catalog => {
					if ((catalog || []).length)
						meta.videos = catalog.map(catToVideo)
					resolve({ meta })
				}, true)
			} else {
				const meta = findMeta(args.id)
				if (!meta) reject(defaults.name + ' - Could not get meta')
				else resolve({ meta })
			}
		})
	})

	builder.defineStreamHandler(args => {
		return new Promise((resolve, reject) => {
			const chanId = args.id.split('_')[2]
			const url = 'http://' + persist.getItem('loginData').url + ':' + persist.getItem('loginData').port + '/live/' + config.username + '/' + config.password + '/' + chanId + '.m3u8'
			resolve({ streams: [ { title: 'Stream', url } ] })
		})
	})

	const addonInterface = getInterface(builder)

	return getRouter(addonInterface)

}

module.exports = retrieveRouter()