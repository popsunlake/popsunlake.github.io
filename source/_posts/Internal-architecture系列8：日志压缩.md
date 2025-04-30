---
title: Internal-architecture系列8-日志压缩
date: 2025-04-30 11:39:04
tags: [kafka, confluent]
categories:
  - [kafka, confluent, raojun]
---

## Topic Compaction

Topic compaction is a data retention mechanism that opens up a plethora of possibilities within Kafka. Let’s dig deeper into what compaction is and how it works.

### Time-Based Retention

<!-- more -->

![time-based-retention](https://images.ctfassets.net/gt6dp23g0g38/4Ah3kH2iotVV5IT8NbxM7U/a6b871c392831b6e533b632c78dbba54/Kafka_Internals_109.png)

Before we talk more about compaction, let’s discuss its counterpart, time-based retention. Time-based retention is specified by setting the cleanup.policy to delete and setting the retention.ms to some number of milliseconds. With this set, events will be kept in the topics at least until they have reached that time limit. Once they have hit that limit, they may not be deleted right away. This is because event deletion happens at the segment level. A segment will be marked for deletion once its youngest event has passed the time threshold.

### Topic Compaction: Key-Based Retention

![topic-compaction-key-based-retention](https://images.ctfassets.net/gt6dp23g0g38/2BxHtchSSShsC39qc0gkfY/49fff2415e3323d3686c40a9ca243b98/Kafka_Internals_110.png)

Compaction is a key-based retention mechanism. To set a topic to use compaction, set its cleanup.policy to compact. The goal of compaction is to keep the most recent value for a given key. This might work well for maintaining the current location of a vehicle in your fleet, or the current balance of an account. However, historical data will be lost, so it may not always be the best choice.

Compaction also provides a way to completely remove a key, by appending an event with that key and a null value. If this null value, also known as a tombstone, is the most recent value for that key, then it will be marked for deletion along with any older occurrences of that key. This could be necessary for things like GDPR compliance.

### Usage and Benefits of Topic Compaction

![usage-and-benefits-of-topic-compaction](https://images.ctfassets.net/gt6dp23g0g38/7gjv8f14EZCKxcFZ9bvqy4/18f1f4dd4605e51a64137c9cb59bbeff/Kafka_Internals_111.png)

Because compaction always keeps the most recent value for each key, it is perfect for providing backing to ksqlDB tables, or Kafka Streams KTables. For updatable datasets, for example, database table data coming into Kafka via CDC, where the current value is all that matters, compacted topics allow you to continue receiving updates without topic storage growing out of hand.

### Compaction Process

The process of compacting a topic can be broken down into several distinct steps. Let’s take a look at each of these steps.

#### Segments to Clean

![compaction-segments-to-clean](https://images.ctfassets.net/gt6dp23g0g38/7xFuGP5VqnQG932Y1C2Lga/5a81852e7f5f3b0b725ff800d3300424/Kafka_Internals_112.png)

Compaction is done by deleting old events from existing segments and, sometimes, copying retained events into new segments. The first step in all of this is to determine which segments to clean. At the beginning of a compacted topic partition, there will be previously cleaned segments. These are segments that have no duplicate keys in them, though there may be duplicates in newer segments. The segments that are newer than this are considered dirty segments. Starting at the first dirty segment, we will grab some number of segments to clean. The precise number depends on the amount of memory available to the cleaner thread.

Also, note that the active segment is never cleaned by this process.

#### Build Dirty Segment Map

![compaction-build-dirty-segment-map](https://images.ctfassets.net/gt6dp23g0g38/3VR60xAKmyX4IuITEddgaZ/4d7d10eb59f774a69fc63228ca919be8/Kafka_Internals_113.png)

Next we will scan through the selected dirty segments, starting at the earliest offset and build an offset map, keyed on the event keys. As newer offsets are found for a given key, the value is updated. The end result is a map of the most recent offset for each key.

#### Deleting Events

![compaction-deleting-events](https://images.ctfassets.net/gt6dp23g0g38/hZz6tucLJcOTqkj9lPZNL/be80984afc494e81836e9ecf46baee7c/Kafka_Internals_114.png)

Now we make another pass through the partition, this time from the beginning, including the previously cleaned segments. For each event, we will check in the dirty segment map looking for its key. If the key is found, and the offset value is higher than that of the event, the event will be deleted.

#### Retaining Events

![compaction-retaining-events](https://images.ctfassets.net/gt6dp23g0g38/3buuGW7hR0fUaFTVF6UkOJ/76adb35c05897179b9deaba2eb6e3dbb/Kafka_Internals_115.png)

The retained events, in both the dirty and cleaned segments, are copied to new log segments. If the total size of retained events from two log segments is less than the topic segment.bytes value, they will be combined into a single new segment as illustrated in the diagram. It’s important to note here that each event’s original offset is maintained, even though that may leave gaps in the offsets.

#### Replace Old Segments

![compaction-replace-old-segments](https://images.ctfassets.net/gt6dp23g0g38/jZGOIHnDT8kPpgXO12kj9/edddc84b8ddee55f64b65952f0503758/Kafka_Internals_116.png)

The final step in the compaction process is to remove the old segments and checkpoint the last cleaned offset, which will mark the beginning of the first dirty segment. The next round of log compaction for the partition will begin with this log segment.

#### Cleaning Tombstone and Transaction Markers

![cleaning-tombstone-and-transaction-markers](https://images.ctfassets.net/gt6dp23g0g38/5ovyWqqmeQjptMMnwy3zdi/ae118b7ebdcb4454c2f67fc5cce0697f/Kafka_Internals_117.png)

Tombstone and transaction markers have special significance to client applications so we need to take some extra precautions so that client applications don’t miss them.

The way this is handled is with a two-stage process. When tombstones or transaction markers are first encountered during cleanup, they are marked with a to-delete-timestamp which is the time of this cleaning plus delete.retention.ms. They will then remain in the partition and be available for clients.

Then, on subsequent cleanings any events whose time-to-delete timestamp has been reached will be removed.

The delay imposed by this two-stage process ensures downstream consumer applications are able to process tombstone and transaction marker events prior to their deletion.

### When Compaction Is Triggered

![when-compaction-is-triggered](https://images.ctfassets.net/gt6dp23g0g38/5VHvIC0y5i2qV7WYgQZHUz/fe013f5cec93a3bb90e5e4900bdfa651/Kafka_Internals_when_compaction_is_triggered_v2.png)

#### Errata

- Errata: there's a small mistake in the video above at 8:56 in the topic compaction section. The first condition should read: “message timestamp < current time - min.compaction.lag.ms” just like on the diagram above.

Normally, compaction will be triggered when the ratio of dirty data to total data reaches the threshold set by the min.cleanable.dirty.ratio configuration, which defaults to 50 percent. However, there are a couple of other configurations that can affect this decision.

To prevent overly aggressive cleaning, we can set the value of min.compaction.lag.ms. With this set, compaction won’t start more frequently than its value even if the dirty/total ratio has been exceeded. This provides a minimum period of time for applications to see an event prior to its deletion.

On the other end of the spectrum, we can set max.compaction.lag.ms, which will trigger a compaction once the time limit has been reached, regardless of the amount of dirty data.

### Topic Compaction Guarantees

![topic-compaction-guarantees](https://images.ctfassets.net/gt6dp23g0g38/5v6tStwUUJxcT2vlWjoyWO/b82451cb03f171f73eac5d907498bf9f/Kafka_Internals_119.png)

Applications reading from compacted topics are guaranteed to see the most recent value for a given key, which is the main use case for compacted topics. But keep in mind that they are not guaranteed to see every value for a given key. Some values may be deleted due to new values being appended, before the application sees them. Some extra steps are made for the case of tombstones and transaction markers, but some other types of events may still be missed.
