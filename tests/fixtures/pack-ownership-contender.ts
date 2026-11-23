import { canonicalPackIdentity, tryClaimPackOwnership } from '../../electron/pack-ownership'

const identity = await canonicalPackIdentity(process.argv[2], process.argv[3])
process.on('message', message => {
  if (message === 'claim') process.send?.(tryClaimPackOwnership(identity).status)
  if (message === 'exit') process.exit(0)
})
process.send?.('ready')
