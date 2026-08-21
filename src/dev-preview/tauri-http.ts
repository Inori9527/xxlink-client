type BrowserPreviewFetchOptions = RequestInit & {
  connectTimeout?: number
}

const response = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

export const fetch = async (
  input: RequestInfo | URL,
  _options?: BrowserPreviewFetchOptions,
): Promise<Response> => {
  const url = String(input)

  if (url.includes('api.ip.sb/geoip')) {
    return new Response(
      JSON.stringify({
        ip: '203.0.113.42',
        country_code: 'ZZ',
        country: 'Preview',
        region: 'Browser',
        city: 'Localhost',
        organization: 'XXLink Browser Preview',
        asn: 64500,
        asn_organization: 'XXLink Browser Preview',
        longitude: 0,
        latitude: 0,
        timezone: 'UTC',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (url.includes('/auth/register')) {
    return response({ id: 'preview-user-001', email: 'preview@xxlink.net' })
  }

  return response(null)
}
