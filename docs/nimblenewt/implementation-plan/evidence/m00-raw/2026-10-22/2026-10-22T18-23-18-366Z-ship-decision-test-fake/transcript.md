# Ship on Friday with a known bug (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: fake

**#1 Chair** _(opening)_
Motion (version 1): The team ships the v2 payments API this Friday as planned, with the known duplicate-charge bug unfixed, and fixes it in the following release.

**#2 Dana** _(round 1 (blind))_ [for]
word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1
> tl;dr (what later speakers saw in summary mode): for because word1 word2 word3 word4 word5

**#3 Ravi** _(round 1 (blind))_ [against]
word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2
> tl;dr (what later speakers saw in summary mode): against because word2 word3 word4 word5 word6

**#4 Mei** _(round 1 (blind))_ [for]
word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3
> tl;dr (what later speakers saw in summary mode): for because word3 word4 word5 word6 word0

**#5 Chair** _(fact-finding question)_
To Dana: experience with the tool (how long and with what result)

**#6 Dana** _(answer to chair)_ [for]
word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5
> tl;dr (what later speakers saw in summary mode): for because word5 word6 word0 word1 word2

**#7 Dana** _(round 2)_ [against]
word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6
> tl;dr (what later speakers saw in summary mode): against because word6 word0 word1 word2 word3

**#8 Ravi** _(round 2)_ [for]
word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0
> tl;dr (what later speakers saw in summary mode): for because word0 word1 word2 word3 word4

**#9 Mei** _(round 2)_ [against]
word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6 word0 word1
> tl;dr (what later speakers saw in summary mode): against because word1 word2 word3 word4 word5

**#10 Mei** _(objection)_
word4 word5 word6 word0 word1 word2 word3 word4

**#11 Chair** _(ruling)_
Proceed.

## Ballots (revealed together at the close)
- Dana: **no** — word0 word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4
- Ravi: **yes** — word1 word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5
- Mei: **no** — word2 word3 word4 word5 word6 word0 word1 word2 word3 word4 word5 word6

Result: {"yes":1,"no":2,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}