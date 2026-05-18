import { getOctokit, context } from '@actions/github'
import fetch from 'node-fetch'

import { resolveUpdateLog, resolveUpdateLogDefault } from './updatelog.mjs'

// Add stable update JSON filenames
const UPDATE_TAG_NAME = 'updater'
const UPDATE_JSON_FILE = 'update.json'
const UPDATE_JSON_PROXY = 'update-proxy.json'
const PUBLIC_DOWNLOAD_BASE_URL = 'https://api.xxlink.net/download'
// Add alpha update JSON filenames
const ALPHA_TAG_NAME = 'updater-alpha'
const ALPHA_UPDATE_JSON_FILE = 'update.json'
const ALPHA_UPDATE_JSON_PROXY = 'update-proxy.json'

/// generate update.json
/// upload to update tag's release asset
async function resolveUpdater() {
  if (process.env.GITHUB_TOKEN === undefined) {
    throw new Error('GITHUB_TOKEN is required')
  }

  const options = { owner: context.repo.owner, repo: context.repo.repo }
  const github = getOctokit(process.env.GITHUB_TOKEN)
  const currentTagName = (
    process.env.GITHUB_REF_NAME ||
    process.env.RELEASE_TAG_NAME ||
    process.env.GITHUB_REF?.replace(/^refs\/tags\//, '') ||
    ''
  ).trim()

  // Fetch published releases instead of raw git tags, because the repository
  // still contains upstream tags that do not map to valid XXLink releases.
  let allReleases = []
  let page = 1
  const perPage = 100

  while (true) {
    const { data: pageReleases } = await github.rest.repos.listReleases({
      ...options,
      per_page: perPage,
      page: page,
    })

    allReleases = allReleases.concat(pageReleases)

    if (pageReleases.length < perPage) {
      break
    }

    page++
  }

  const releases = allReleases.filter((release) => !release.draft)
  const currentRelease = currentTagName
    ? releases.find((release) => release.tag_name === currentTagName)
    : null
  const stableRelease = currentRelease?.prerelease
    ? null
    : currentRelease ||
      releases.find(
        (release) =>
          !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name),
      )
  const preRelease = currentRelease?.prerelease
    ? currentRelease
    : releases.find(
        (release) =>
          release.prerelease && /(?:alpha|beta|rc|pre)/i.test(release.tag_name),
      )

  console.log(`Retrieved ${releases.length} published releases in total`)
  console.log('Current workflow tag:', currentTagName || 'None found')
  console.log('All releases:', releases.map((r) => r.tag_name).join(', '))
  console.log(
    'Stable release:',
    stableRelease ? stableRelease.tag_name : 'None found',
  )
  console.log(
    'Pre-release release:',
    preRelease ? preRelease.tag_name : 'None found',
  )
  console.log()

  if (currentTagName && !currentRelease) {
    throw new Error(`Release ${currentTagName} was not found`)
  }

  if (stableRelease) {
    await processRelease(github, options, stableRelease, false)
  }

  if (preRelease) {
    await processRelease(github, options, preRelease, true)
  }
}

// Process a release (stable or alpha) and generate update files
async function processRelease(github, options, release, isAlpha) {
  if (!release) return

  const updateData = {
    name: release.tag_name,
    version: release.tag_name.replace(/^v/i, ''),
    notes: await resolveUpdateLog(release.tag_name).catch(() =>
      resolveUpdateLogDefault().catch(() => 'No changelog available'),
    ),
    pub_date: release.published_at || new Date().toISOString(),
    platforms: {
      win64: { signature: '', url: '' }, // compatible with older formats
      'windows-x86_64': { signature: '', url: '' },
    },
  }

  const promises = release.assets.map(async (asset) => {
    const { name, browser_download_url } = asset
    const publicAssetUrl = resolvePublicAssetUrl(name, browser_download_url)

    // Process all the platform URL and signature data
    // win64 url
    if (name.endsWith('x64-setup.exe')) {
      updateData.platforms.win64.url = publicAssetUrl
      updateData.platforms['windows-x86_64'].url = publicAssetUrl
    }
    // win64 signature
    if (name.endsWith('x64-setup.exe.sig')) {
      const sig = await getSignature(browser_download_url)
      updateData.platforms.win64.signature = sig
      updateData.platforms['windows-x86_64'].signature = sig
    }
  })

  await Promise.allSettled(promises)
  console.log(updateData)

  // maybe should test the signature as well
  // delete the null field
  Object.entries(updateData.platforms).forEach(([key, value]) => {
    if (!value.url) {
      console.log(`[Error]: failed to parse release for "${key}"`)
      delete updateData.platforms[key]
    }
  })

  // Generate a proxy update file for accelerated GitHub resources
  const updateDataNew = JSON.parse(JSON.stringify(updateData))

  Object.entries(updateDataNew.platforms).forEach(([key, value]) => {
    if (value.url) {
      updateDataNew.platforms[key].url = value.url
    } else {
      console.log(`[Error]: updateDataNew.platforms.${key} is null`)
    }
  })

  const releaseTag = isAlpha ? ALPHA_TAG_NAME : UPDATE_TAG_NAME
  console.log(`Processing ${isAlpha ? 'alpha' : 'stable'} release:`, releaseTag)

  try {
    let updateRelease

    try {
      const response = await github.rest.repos.getReleaseByTag({
        ...options,
        tag: releaseTag,
      })
      updateRelease = response.data
      console.log(
        `Found existing ${releaseTag} release with ID: ${updateRelease.id}`,
      )
    } catch (error) {
      if (error.status === 404) {
        console.log(
          `Release with tag ${releaseTag} not found, creating new release...`,
        )
        const createResponse = await github.rest.repos.createRelease({
          ...options,
          tag_name: releaseTag,
          name: isAlpha
            ? 'Auto-update Alpha Channel'
            : 'Auto-update Stable Channel',
          body: `This release contains the update information for ${isAlpha ? 'alpha' : 'stable'} channel.`,
          prerelease: isAlpha,
        })
        updateRelease = createResponse.data
        console.log(
          `Created new ${releaseTag} release with ID: ${updateRelease.id}`,
        )
      } else {
        throw error
      }
    }

    const jsonFile = isAlpha ? ALPHA_UPDATE_JSON_FILE : UPDATE_JSON_FILE
    const proxyFile = isAlpha ? ALPHA_UPDATE_JSON_PROXY : UPDATE_JSON_PROXY

    for (const asset of updateRelease.assets) {
      if (asset.name === jsonFile) {
        await github.rest.repos.deleteReleaseAsset({
          ...options,
          asset_id: asset.id,
        })
      }

      if (asset.name === proxyFile) {
        await github.rest.repos
          .deleteReleaseAsset({ ...options, asset_id: asset.id })
          .catch(console.error)
      }
    }

    await github.rest.repos.uploadReleaseAsset({
      ...options,
      release_id: updateRelease.id,
      name: jsonFile,
      data: JSON.stringify(updateData, null, 2),
    })

    await github.rest.repos.uploadReleaseAsset({
      ...options,
      release_id: updateRelease.id,
      name: proxyFile,
      data: JSON.stringify(updateDataNew, null, 2),
    })

    console.log(
      `Successfully uploaded ${isAlpha ? 'alpha' : 'stable'} update files to ${releaseTag}`,
    )
  } catch (error) {
    console.error(
      `Failed to process ${isAlpha ? 'alpha' : 'stable'} release:`,
      error.message,
    )
    throw error
  }
}

// get the signature file content
async function getSignature(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/octet-stream' },
  })

  return response.text()
}

function resolvePublicAssetUrl(name, fallbackUrl) {
  if (
    /^XXLink_.*_(x64|x86|arm64)(?:_fixed_webview2)?-setup\.exe$/i.test(name)
  ) {
    return `${PUBLIC_DOWNLOAD_BASE_URL}/${name}`
  }

  return fallbackUrl
}

resolveUpdater().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
