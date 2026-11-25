/**
 * FIRESTORE PHOTO STORE
 *
 * The bytes moved from Cloud Storage to Firestore because Storage needs a
 * billing plan this project does not have. The properties that matter are the
 * ones the rules depend on:
 *
 *   - a deterministic document id per member / per gym, so re-uploading
 *     overwrites in place and can never strand an orphan
 *   - the gym id written into the document is the one the caller passed from the
 *     signed-in profile, never a member document's field
 *   - exactly the seven keys the rules allowlist accepts, no more
 *   - a client-side size refusal BEFORE the write, so the operator sees a
 *     message instead of PERMISSION_DENIED
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    doc: vi.fn(() => ({ id: 'ref' })),
    getDoc: vi.fn(),
    setDoc: vi.fn(),
    serverTimestamp: vi.fn(() => 'SERVER_TS'),
    makeThumbnail: vi.fn(),
  },
}))

vi.mock('firebase/firestore', () => ({
  doc: mocks.doc,
  getDoc: mocks.getDoc,
  setDoc: mocks.setDoc,
  serverTimestamp: mocks.serverTimestamp,
}))

vi.mock('@/firebase', () => ({ db: { fake: true }, isFirebaseConfigured: true }))

vi.mock('@/utils/image', () => ({
  MAX_STORED_BYTES: 300 * 1024,
  makeThumbnail: mocks.makeThumbnail,
}))

const {
  BRANDING_DOC_ID,
  MEMBER_PHOTOS_COLLECTION,
  loadGymLogo,
  loadMemberPhoto,
  saveGymLogo,
  saveMemberPhoto,
} = await import('@/services/photoStore')

const GYM = 'gym-alpha'
const MEMBER = 'member-1'
const THUMB = {
  dataUrl: 'data:image/webp;base64,' + 'A'.repeat(64),
  contentType: 'image/webp',
  width: 320,
  height: 240,
  bytes: 48,
}
const file = () => new File([new Uint8Array(8)], 'photo.jpg', { type: 'image/jpeg' })

/** The document path the mocked `doc()` was asked for, minus the db argument. */
const docPath = (call = 0) => mocks.doc.mock.calls[call].slice(1)

describe('saveMemberPhoto', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.makeThumbnail.mockResolvedValue(THUMB)
    mocks.setDoc.mockResolvedValue(undefined)
  })

  it('writes one deterministic document per member', async () => {
    await saveMemberPhoto(GYM, MEMBER, file())

    expect(docPath()).toEqual([MEMBER_PHOTOS_COLLECTION, MEMBER])
    expect(mocks.setDoc).toHaveBeenCalledTimes(1)
  })

  it('writes exactly the keys the rules allowlist accepts', async () => {
    await saveMemberPhoto(GYM, MEMBER, file(), { uploadedBy: 'uid-1' })

    const [, payload] = mocks.setDoc.mock.calls[0]
    expect(Object.keys(payload).sort()).toEqual(
      ['contentType', 'data', 'gymId', 'height', 'updatedAt', 'updatedBy', 'width'].sort()
    )
    expect(payload.gymId).toBe(GYM)
    expect(payload.data).toBe(THUMB.dataUrl)
    expect(payload.contentType).toBe('image/webp')
    expect(payload.width).toBe(320)
    expect(payload.height).toBe(240)
    expect(payload.updatedAt).toBe('SERVER_TS')
    expect(payload.updatedBy).toBe('uid-1')
  })

  it('returns the bytes it stored so the caller can render immediately', async () => {
    const result = await saveMemberPhoto(GYM, MEMBER, file())
    expect(result).toMatchObject({ memberId: MEMBER, dataUrl: THUMB.dataUrl, bytes: 48 })
  })

  it('refuses to build a document without a gym identity', async () => {
    await expect(saveMemberPhoto(null, MEMBER, file())).rejects.toThrow(/gym identity/i)
    await expect(saveMemberPhoto('   ', MEMBER, file())).rejects.toThrow(/gym identity/i)
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })

  it('refuses to build a document without a member id', async () => {
    await expect(saveMemberPhoto(GYM, '', file())).rejects.toThrow(/member id/i)
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })

  // The rules cap the stored string at 300 KB. Checking here first turns that
  // denial into a sentence the person uploading can act on.
  it('refuses a thumbnail that the rules would reject', async () => {
    mocks.makeThumbnail.mockResolvedValue({ ...THUMB, bytes: 400 * 1024 })
    await expect(saveMemberPhoto(GYM, MEMBER, file())).rejects.toThrow(/too large/)
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })

  it('does not swallow an encode failure', async () => {
    mocks.makeThumbnail.mockRejectedValue(new Error('Unsupported image type'))
    await expect(saveMemberPhoto(GYM, MEMBER, file())).rejects.toThrow(/Unsupported image type/)
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })
})

describe('saveGymLogo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.makeThumbnail.mockResolvedValue(THUMB)
    mocks.setDoc.mockResolvedValue(undefined)
  })

  it('writes the gym branding document the settings rules already gate', async () => {
    await saveGymLogo(GYM, file())

    expect(docPath()).toEqual(['gyms', GYM, 'settings', BRANDING_DOC_ID])
    const [, payload] = mocks.setDoc.mock.calls[0]
    expect(payload.gymId).toBe(GYM)
    expect(payload.data).toBe(THUMB.dataUrl)
  })

  it('requires a gym identity before writing', async () => {
    await expect(saveGymLogo(undefined, file())).rejects.toThrow(/gym identity/i)
    expect(mocks.setDoc).not.toHaveBeenCalled()
  })
})

describe('reads', () => {
  const snapshot = (value) => ({ exists: () => value !== undefined, data: () => value })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the stored data URL for a member', async () => {
    mocks.getDoc.mockResolvedValue(snapshot({ data: THUMB.dataUrl }))
    await expect(loadMemberPhoto(MEMBER)).resolves.toBe(THUMB.dataUrl)
    expect(docPath()).toEqual([MEMBER_PHOTOS_COLLECTION, MEMBER])
  })

  it('returns null when no photo is stored', async () => {
    mocks.getDoc.mockResolvedValue(snapshot(undefined))
    await expect(loadMemberPhoto(MEMBER)).resolves.toBeNull()
  })

  // A document whose `data` is not a data URL (a hand-edited doc, or a field
  // renamed in a future migration) must not become an <img src>.
  it('ignores a document that does not carry an image data URL', async () => {
    mocks.getDoc.mockResolvedValue(snapshot({ data: 'https://elsewhere/photo.jpg' }))
    await expect(loadMemberPhoto(MEMBER)).resolves.toBeNull()
  })

  it('does not read when there is no id', async () => {
    await expect(loadMemberPhoto('')).resolves.toBeNull()
    expect(mocks.getDoc).not.toHaveBeenCalled()
  })

  it('returns the gym logo and asks for the branding document', async () => {
    mocks.getDoc.mockResolvedValue(snapshot({ data: THUMB.dataUrl }))
    await expect(loadGymLogo(GYM)).resolves.toBe(THUMB.dataUrl)
    expect(docPath()).toEqual(['gyms', GYM, 'settings', BRANDING_DOC_ID])
  })

  it('propagates a denied read so the caller can show initials', async () => {
    mocks.getDoc.mockRejectedValue(new Error('permission-denied'))
    await expect(loadMemberPhoto(MEMBER)).rejects.toThrow('permission-denied')
  })
})
