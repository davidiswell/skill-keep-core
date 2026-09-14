# Security and confidentiality

Please do not put confidential skill content or exploitable credentials into a public issue. Reproduce problems using synthetic text and minimal fictional files. This project does not operate a private vulnerability inbox yet; an organization deploying it should provide an appropriate internal reporting route.

This is review assistance, not a certified DLP system, ownership determination, legal clearance, or authenticated employer policy service. Treat models as fallible. Keep original imports under local access controls. Release only after reviewing exact content and the applicable rights.

Do not execute imported code to evaluate a skill. Do not give a model filesystem, network, or tool access. A receipt's included public key is untrusted until independently verified.

Findings and change histories can contain original sensitive excerpts. Keep these reports under the same access controls as the source package, and avoid writing them to shared logs.

The package supplies no inference transport or provider credential storage. A host application that supplies a model adapter must verify where it runs and obtain explicit consent before transmitting skill content to a provider. The benchmark's mode label does not verify the adapter's execution environment. API transport must not grant the model tools or access to unrelated files.
