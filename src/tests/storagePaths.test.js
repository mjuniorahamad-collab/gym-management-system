/**
 * STORAGE PHASE 3B — CLIENT PATH GENERATION
 *
 * The gym-scoped object layout is a security boundary, so the pure path helpers
 * in src/services/storage.js are asserted directly rather than only through the
 * components that call them. Nothing here touches the network: firebase/storage
 * is mocked because these tests are about the strings the client asks for.
 *
 * What is pinned:
 *   - gym-scoped member-photo paths, member-specific
 *   - a stable, deterministic per-gym branding path (no Date.now(), no orphan)
 *   - a blank or missing gym identity is refused instead of producing an
 *     unscoped path
 *   - the revoked flat prefixes are never produced
 *   - no client delete capability is exported at all
 *   - client validation agrees with the storage.rules limits (UX only)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  ALLOWED_IMAGE_TYPES,
  LOGO_FILENAME,
  MAX_LOGO_BYTES,
  MAX_MEMBER_PHOTO_BYTES,
  MEMBER_PHOTO_FILENAME,
  logoPath,
  memberPhotoPath,
  readObjectUrl,
  uploadGymLogo,
  uploadMemberPhoto,
  validateImageFile,
} from '@/services/storage'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    uploadBytes: vi.fn(),
    getBytes: vi.fn(),
  },
}))

// getDownloadURL is deliberately NOT mocked: the service must no longer import
// it. Minting a download token is the bearer-URL leak this phase removed, so
// having it available here would let the leak back in unnoticed.
vi.mock('firebase/storage', () => ({
  ref: (_storage, path) => ({ path, kind: 'ref' }),
  uploadBytes: mocks.uploadBytes,
  getBytes: mocks.getBytes,
  // deleteObject is deliberately absent: the service must not expose a client
  // delete path. If this mock ever needs it, that is a signal the service has
  // reintroduced a capability storage.rules denies.
}))

vi.mock('@/firebase', () => ({
  isFirebaseConfigured: true,
  storage: { name: 'test-storage' },
}))

const GYM_A = 'gym-alpha'
const GYM_B = 'gym-beta'
const MEMBER = 'member-123'
const PHOTO_PATH = `gyms/${GYM_A}/memberPhotos/${MEMBER}/photo.jpg`
const LOGO_PATH = `gyms/${GYM_A}/branding/logo.png`

const pngFile = (bytes = 8, type = 'image/png', name = 'photo.png') =>
  new File([new Uint8Array(bytes)], name, { type })

describe('Storage path generation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.uploadBytes.mockResolvedValue({ ref: { path: 'x' } })
    mocks.getBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
  })

  // ---- member photos ------------------------------------------------
  it('builds a gym-scoped member photo path', () => {
    expect(memberPhotoPath(GYM_A, MEMBER)).toBe(
      `gyms/${GYM_A}/memberPhotos/${MEMBER}/${MEMBER_PHOTO_FILENAME}`,
    )
  })

  it('is member-specific: two members never share an object', () => {
    expect(memberPhotoPath(GYM_A, 'm1')).not.toBe(memberPhotoPath(GYM_A, 'm2'))
  })

  it('is gym-specific: the same member id in two gyms never shares an object', () => {
    expect(memberPhotoPath(GYM_A, MEMBER)).not.toBe(memberPhotoPath(GYM_B, MEMBER))
  })

  it('produces a deterministic member photo path', () => {
    expect(memberPhotoPath(GYM_A, MEMBER)).toBe(memberPhotoPath(GYM_A, MEMBER))
  })

  it('never produces the revoked flat memberPhotos prefix', () => {
    expect(memberPhotoPath(GYM_A, MEMBER).startsWith('memberPhotos/')).toBe(false)
  })

  it('refuses a missing or blank gym identity', () => {
    expect(() => memberPhotoPath(null, MEMBER)).toThrow(/gym identity/i)
    expect(() => memberPhotoPath('', MEMBER)).toThrow(/gym identity/i)
    expect(() => memberPhotoPath('   ', MEMBER)).toThrow(/gym identity/i)
  })

  it('refuses a missing member id', () => {
    expect(() => memberPhotoPath(GYM_A, '')).toThrow(/member id/i)
    expect(() => memberPhotoPath(GYM_A, null)).toThrow(/member id/i)
  })

  // ---- branding -----------------------------------------------------
  it('builds a gym-scoped branding path', () => {
    expect(logoPath(GYM_A)).toBe(`gyms/${GYM_A}/branding/${LOGO_FILENAME}`)
  })

  it('is deterministic for a gym: repeated uploads resolve to one object', () => {
    const first = logoPath(GYM_A)
    const later = logoPath(GYM_A)
    expect(later).toBe(first)
    // The old implementation embedded Date.now(), which minted a new object per
    // upload and stranded the previous one.
    expect(first).not.toMatch(/\d{10,}/)
  })

  it('gives each gym its own branding object', () => {
    expect(logoPath(GYM_A)).not.toBe(logoPath(GYM_B))
  })

  it('never produces the revoked flat logos prefix', () => {
    expect(logoPath(GYM_A).startsWith('logos/')).toBe(false)
  })

  it('refuses a missing or blank gym identity', () => {
    expect(() => logoPath(null)).toThrow(/gym identity/i)
    expect(() => logoPath('')).toThrow(/gym identity/i)
  })

  it('matches the shape storage.rules publishes', () => {
    // gymId / memberId / filename are each exactly one path segment, which is
    // what the rules' single-segment wildcards bind. A slash smuggled into any
    // segment would produce a path the rules do not match (and would therefore
    // be denied) rather than a different object.
    const photo = memberPhotoPath(GYM_A, MEMBER).split('/')
    expect(photo).toHaveLength(5)
    expect(photo[0]).toBe('gyms')
    expect(photo[2]).toBe('memberPhotos')
    expect(logoPath(GYM_A).split('/')).toHaveLength(4)
  })

  // ---- upload wrappers ----------------------------------------------
  // Uploads return a PATH only. A returned URL would be a download token, and
  // the caller persisting one is exactly the leak D1 forbids.
  it('uploads a member photo to the scoped path and returns only the path', async () => {
    const result = await uploadMemberPhoto(GYM_A, MEMBER, pngFile())
    const [refArg] = mocks.uploadBytes.mock.calls[0]
    expect(refArg.path).toBe(PHOTO_PATH)
    expect(result).toEqual({ path: PHOTO_PATH })
    expect(result.url).toBeUndefined()
  })

  it('uploads a logo to the scoped branding path and returns only the path', async () => {
    const result = await uploadGymLogo(GYM_A, pngFile())
    const [refArg] = mocks.uploadBytes.mock.calls[0]
    expect(refArg.path).toBe(LOGO_PATH)
    expect(result).toEqual({ path: LOGO_PATH })
    expect(result.url).toBeUndefined()
  })

  it('refuses to upload without a gym identity, before touching Storage', async () => {
    await expect(uploadMemberPhoto(null, MEMBER, pngFile())).rejects.toThrow(/gym identity/i)
    await expect(uploadGymLogo('', pngFile())).rejects.toThrow(/gym identity/i)
    expect(mocks.uploadBytes).not.toHaveBeenCalled()
  })

  it('rejects an unsupported type before uploading', async () => {
    const html = new File(['<script>'], 'x.html', { type: 'text/html' })
    await expect(uploadMemberPhoto(GYM_A, MEMBER, html)).rejects.toThrow(/Unsupported image type/i)
    expect(mocks.uploadBytes).not.toHaveBeenCalled()
  })

  it('rejects an oversize photo before uploading', async () => {
    const big = pngFile(MAX_MEMBER_PHOTO_BYTES + 1)
    await expect(uploadMemberPhoto(GYM_A, MEMBER, big)).rejects.toThrow(/too large/i)
    expect(mocks.uploadBytes).not.toHaveBeenCalled()
  })

  it('rejects an oversize logo before uploading', async () => {
    const big = pngFile(MAX_LOGO_BYTES + 1)
    await expect(uploadGymLogo(GYM_A, big)).rejects.toThrow(/too large/i)
    expect(mocks.uploadBytes).not.toHaveBeenCalled()
  })

  // ---- validation agrees with the rules ------------------------------
  it('accepts exactly the types the rules allow', () => {
    expect(ALLOWED_IMAGE_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp'])
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(validateImageFile(pngFile(8, type), MAX_LOGO_BYTES)).toBeNull()
    }
  })

  it('rejects the types the rules reject', () => {
    for (const type of ['text/html', 'application/pdf', 'image/svg+xml', 'image/gif']) {
      expect(validateImageFile(pngFile(8, type), MAX_LOGO_BYTES)).toMatch(/Unsupported/i)
    }
  })

  it('mirrors the rules size caps', () => {
    expect(MAX_MEMBER_PHOTO_BYTES).toBe(5 * 1024 * 1024)
    expect(MAX_LOGO_BYTES).toBe(2 * 1024 * 1024)
  })

  it('reports a missing file', () => {
    expect(validateImageFile(null, MAX_LOGO_BYTES)).toMatch(/No file/i)
  })
})

describe('Secure runtime reads (D1)', () => {
  let createObjectURL
  let revokeObjectURL

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
    // jsdom does not implement the blob URL factory; the hook under test and
    // this suite both need a deterministic stand-in.
    createObjectURL = vi.fn(() => 'blob:mock-url')
    revokeObjectURL = vi.fn()
    global.URL.createObjectURL = createObjectURL
    global.URL.revokeObjectURL = revokeObjectURL
  })

  // Reads must go through getBytes, not getDownloadURL: getBytes re-authorises
  // each request against storage.rules, while a download token would not.
  it('fetches bytes for the path and returns a blob URL', async () => {
    const url = await readObjectUrl(PHOTO_PATH)

    const [refArg] = mocks.getBytes.mock.calls[0]
    expect(refArg.path).toBe(PHOTO_PATH)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(url).toBe('blob:mock-url')
  })

  it('reads a logo by its deterministic branding path', async () => {
    await readObjectUrl(LOGO_PATH)
    expect(mocks.getBytes.mock.calls[0][0].path).toBe(LOGO_PATH)
  })

  it('types the blob from the path extension', async () => {
    await readObjectUrl(PHOTO_PATH)
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('image/jpeg')
  })

  it('keeps an unknown extension opaque rather than guessing', async () => {
    await readObjectUrl(`gyms/${GYM_A}/branding/logo.bin`)
    expect(createObjectURL.mock.calls[0][0].type).toBe('application/octet-stream')
  })

  it('refuses a blank path rather than reading the bucket root', async () => {
    await expect(readObjectUrl('')).rejects.toThrow(/path is required/i)
    await expect(readObjectUrl(null)).rejects.toThrow(/path is required/i)
    expect(mocks.getBytes).not.toHaveBeenCalled()
  })

  // A denied read must surface as an error. Swallowing it would leave the UI
  // indistinguishable from "this member has no photo".
  it('propagates a denied read', async () => {
    mocks.getBytes.mockRejectedValue(new Error('storage/unauthorized'))
    await expect(readObjectUrl(PHOTO_PATH)).rejects.toThrow('storage/unauthorized')
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})