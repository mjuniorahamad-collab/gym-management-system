/**
 * MEMBER PHOTO UPLOAD FLOW (Firestore store)
 *
 * Cloud Storage needs a billing plan this project does not have, so an avatar is
 * now a 320px base64 thumbnail in `memberPhotos/{memberId}`. The client half of
 * that contract still has to be pinned:
 *
 *   - the gym id comes from the signed-in profile, never from the member
 *     document or a prop (a member row cannot redirect an upload into another
 *     gym)
 *   - each member gets their own document
 *   - staff who may write get the control; a viewer does not
 *   - a failure is reported (toast + console), not swallowed
 *   - rendering prefers stored bytes over any legacy path or URL, and never
 *     shows one member's photo under another member's name
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemberPhoto } from '@/components/common/MemberPhoto'

const { mocks, authValue, photoState } = vi.hoisted(() => ({
  mocks: { saveMemberPhoto: vi.fn(), useMemberPhoto: vi.fn(), readObjectUrl: vi.fn(), toastError: vi.fn() },
  authValue: { gymId: 'gym-alpha' },
  photoState: { dataUrl: null, loading: false, error: null },
}))

vi.mock('@/services/photoStore', () => ({ saveMemberPhoto: mocks.saveMemberPhoto }))
vi.mock('@/hooks/usePhotoStore', () => ({ useMemberPhoto: mocks.useMemberPhoto }))
vi.mock('@/services/storage', () => ({ readObjectUrl: mocks.readObjectUrl }))
vi.mock('@/context/AuthContext', () => ({ useAuth: () => authValue }))
vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ error: mocks.toastError, success: vi.fn(), info: vi.fn(), toast: vi.fn() }),
}))

const GYM_ID = 'gym-alpha'
const MEMBER = { id: 'member-1', name: 'Ayesha Khan', gymId: 'gym-alpha' }
const PHOTO_PATH = `gyms/${GYM_ID}/memberPhotos/${MEMBER.id}/photo.jpg`
const STORED = 'data:image/webp;base64,AAAA'
const UPLOADED = 'data:image/webp;base64,BBBB'

const pngFile = (bytes = 8, type = 'image/png', name = 'photo.png') =>
  new File([new Uint8Array(bytes)], name, { type })

/** The input only exists when the component is editable. */
const photoInput = (container) => container.querySelector('input[type="file"]')

const pick = (container, file = pngFile()) => userEvent.upload(photoInput(container), file)

describe('MemberPhoto upload', () => {
  let errorSpy

  beforeEach(() => {
    vi.clearAllMocks()
    authValue.gymId = GYM_ID
    photoState.dataUrl = null
    photoState.loading = false
    photoState.error = null
    mocks.useMemberPhoto.mockReturnValue(photoState)
    mocks.saveMemberPhoto.mockResolvedValue({ dataUrl: UPLOADED, memberId: MEMBER.id })
    mocks.readObjectUrl.mockResolvedValue('blob:mock-url')
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
    global.URL.revokeObjectURL = vi.fn()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('saves with the authenticated gym and reports the stored bytes', async () => {
    const onUpload = vi.fn()
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={onUpload} />)

    await pick(container)

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith({ dataUrl: UPLOADED }))
    const [gymIdArg, memberIdArg, fileArg] = mocks.saveMemberPhoto.mock.calls[0]
    expect(gymIdArg).toBe(GYM_ID)
    expect(memberIdArg).toBe(MEMBER.id)
    expect(fileArg).toBeInstanceOf(File)
  })

  // The trust boundary. A caller controls `member`, so the member's own gymId
  // field is attacker-controlled data. If the component trusted it, a member row
  // pointing at another gym would file the photo under that gym.
  it('ignores the member document gymId and uses the authenticated gym', async () => {
    const foreign = { id: 'member-1', name: 'Ayesha Khan', gymId: 'gym-victim' }
    const { container } = render(<MemberPhoto member={foreign} editable onUpload={vi.fn()} />)

    await pick(container)

    await waitFor(() => expect(mocks.saveMemberPhoto).toHaveBeenCalled())
    expect(mocks.saveMemberPhoto.mock.calls[0][0]).toBe(GYM_ID)
    expect(mocks.saveMemberPhoto.mock.calls[0][0]).not.toBe('gym-victim')
  })

  it('gives each member a distinct document', async () => {
    const a = render(<MemberPhoto member={{ id: 'm1', name: 'A' }} editable onUpload={vi.fn()} />)
    const b = render(<MemberPhoto member={{ id: 'm2', name: 'B' }} editable onUpload={vi.fn()} />)

    await pick(a.container)
    await waitFor(() => expect(mocks.saveMemberPhoto).toHaveBeenCalledTimes(1))
    await pick(b.container)
    await waitFor(() => expect(mocks.saveMemberPhoto).toHaveBeenCalledTimes(2))

    const ids = mocks.saveMemberPhoto.mock.calls.map(([, memberId]) => memberId)
    expect(ids).toEqual(['m1', 'm2'])
  })

  it('offers the upload control only when editable', () => {
    const allowed = render(<MemberPhoto member={MEMBER} editable onUpload={vi.fn()} />)
    const denied = render(<MemberPhoto member={MEMBER} editable={false} />)

    expect(photoInput(allowed.container)).toBeTruthy()
    expect(denied.container.querySelector('input[type="file"]')).toBeNull()
    expect(denied.container.querySelector('[aria-label="Upload photo"]')).toBeNull()
    expect(mocks.saveMemberPhoto).not.toHaveBeenCalled()
  })

  it('renders the stored thumbnail from memberPhotos and ignores a stale URL', () => {
    photoState.dataUrl = STORED
    const { container } = render(
      <MemberPhoto member={{ ...MEMBER, photoUrl: 'https://stale/token' }} />
    )

    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(STORED)
    expect(img?.getAttribute('src')).not.toContain('stale')
    // Stored bytes are already in hand: nothing is fetched, nothing leaks.
    expect(mocks.readObjectUrl).not.toHaveBeenCalled()
  })

  // Bytes from the store win over a path, because the path points at a bucket
  // that does not exist for this project.
  it('prefers stored bytes over a legacy object path', () => {
    photoState.dataUrl = STORED
    render(<MemberPhoto member={{ ...MEMBER, photoPath: PHOTO_PATH }} />)

    expect(mocks.readObjectUrl).not.toHaveBeenCalled()
  })

  // Documents written while Cloud Storage was still intended keep rendering.
  it('reads a legacy object path when no thumbnail is stored', async () => {
    const { container } = render(<MemberPhoto member={{ ...MEMBER, photoPath: PHOTO_PATH }} />)

    await waitFor(() => expect(mocks.readObjectUrl).toHaveBeenCalledWith(PHOTO_PATH))
    const img = await waitFor(() => container.querySelector('img'))
    expect(img.getAttribute('src')).toBe('blob:mock-url')
  })

  it('renders a legacy stored URL when there is no thumbnail and no path', () => {
    const legacyUrl = 'https://example.test/legacy/photo.jpg'
    const { container } = render(<MemberPhoto member={{ ...MEMBER, photoUrl: legacyUrl }} />)

    expect(container.querySelector('img')?.getAttribute('src')).toBe(legacyUrl)
    expect(mocks.readObjectUrl).not.toHaveBeenCalled()
  })

  it('shows the upload it just made without waiting for a re-read', async () => {
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={vi.fn()} />)

    await pick(container)

    const img = await waitFor(() => container.querySelector('img'))
    expect(img.getAttribute('src')).toBe(UPLOADED)
  })

  // A member list reuses one MemberPhoto instance per row position, so the
  // upload preview must be tied to the member it came from. Without that tie the
  // previous member's face stayed on screen under the next member's name.
  it('drops the upload preview when the row points at another member', async () => {
    const { container, rerender } = render(
      <MemberPhoto member={MEMBER} editable onUpload={vi.fn()} />
    )
    await pick(container)
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(UPLOADED))

    rerender(
      <MemberPhoto member={{ id: 'member-2', name: 'Bilal Khan' }} editable onUpload={vi.fn()} />
    )

    await waitFor(() => expect(container.querySelector('img')).toBeNull())
    expect(container.textContent).toContain('BK')
  })

  // The other half of the same rule: the new row's own stored thumbnail is what
  // must render, not the bytes left behind by the previous member.
  it("renders the new member's stored thumbnail instead of the previous upload", async () => {
    const { container, rerender } = render(
      <MemberPhoto member={MEMBER} editable onUpload={vi.fn()} />
    )
    await pick(container)
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(UPLOADED))

    photoState.dataUrl = STORED
    rerender(
      <MemberPhoto member={{ id: 'member-2', name: 'Bilal Khan' }} editable onUpload={vi.fn()} />
    )

    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(STORED))
  })

  it('falls back to initials when there is no photo', () => {
    const { container } = render(<MemberPhoto member={MEMBER} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('AK')
  })

  // Read cost. A members page renders 20 rows and Firestore bills one document
  // read per avatar, so a row for a member with no photo must ask for nothing.
  it('does not ask for a photo when the member has none', () => {
    render(<MemberPhoto member={MEMBER} />)
    expect(mocks.useMemberPhoto).toHaveBeenCalledWith(null)
  })

  it('asks for the stored photo only for a member flagged hasPhoto', () => {
    render(<MemberPhoto member={{ ...MEMBER, hasPhoto: true }} />)
    expect(mocks.useMemberPhoto).toHaveBeenCalledWith(MEMBER.id)
  })

  // Visual states: a loading avatar shows a skeleton over the initials instead of
  // an empty circle, and the hover overlay only exists where a photo can change.
  it('shows a skeleton while the stored photo is loading', () => {
    photoState.loading = true
    const { container } = render(<MemberPhoto member={{ ...MEMBER, hasPhoto: true }} />)
    expect(container.querySelector('[data-photo-skeleton]')).toBeTruthy()
  })

  it('shows the hover affordance only for staff who may change the photo', () => {
    const editable = render(<MemberPhoto member={{ ...MEMBER, hasPhoto: true }} editable />)
    const readOnly = render(<MemberPhoto member={{ ...MEMBER, hasPhoto: true }} />)

    expect(editable.container.querySelector('[data-photo-hover]')).toBeTruthy()
    expect(readOnly.container.querySelector('[data-photo-hover]')).toBeNull()
  })

  // The component holds no identity of its own to substitute, so the only
  // correct behaviour when the profile has no gym is to forward that absence
  // and let the service refuse.
  it('forwards the missing gym identity and surfaces the refusal', async () => {
    authValue.gymId = null
    mocks.saveMemberPhoto.mockImplementation((gymId) =>
      gymId
        ? Promise.resolve({ dataUrl: UPLOADED })
        : Promise.reject(new Error('A gym identity is required'))
    )
    const onUpload = vi.fn()
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={onUpload} />)

    await pick(container)

    await waitFor(() => expect(mocks.saveMemberPhoto).toHaveBeenCalled())
    expect(mocks.saveMemberPhoto.mock.calls[0][0]).toBeNull()
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(onUpload).not.toHaveBeenCalled()
  })

  // Regression: the failure used to be console-only, so the operator clicked a
  // dead button. The message must reach the screen.
  it('shows the failure and does not report a photo', async () => {
    mocks.saveMemberPhoto.mockRejectedValue(new Error('permission-denied'))
    const onUpload = vi.fn()
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={onUpload} />)

    await pick(container)

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('permission-denied'))
    expect(onUpload).not.toHaveBeenCalled()
  })

  it('allows re-picking the same file after an attempt', async () => {
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={vi.fn()} />)

    await pick(container)
    await waitFor(() => expect(mocks.saveMemberPhoto).toHaveBeenCalledTimes(1))
    await pick(container)
    await waitFor(() => expect(mocks.saveMemberPhoto).toHaveBeenCalledTimes(2))
  })

  it('clears the uploader when the attempt finishes, so the control is usable again', async () => {
    const { container } = render(<MemberPhoto member={MEMBER} editable onUpload={vi.fn()} />)

    await pick(container)

    await waitFor(() =>
      expect(container.querySelector('[aria-label="Upload photo"]')).not.toBeDisabled()
    )
  })
})
